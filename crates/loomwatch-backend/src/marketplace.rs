//! Installing skills from GitHub, skills.sh and `ClawHub` into `LoomWatch`'s own skills folder.
//!
//! The daemon does all the fetching; the Skills page never calls these sites itself. Installing
//! takes two requests. Inspect downloads the skill, unpacks it into a staging folder and lists
//! every skill folder in it with its license, files and scripts, so the person sees what they
//! would get. Install then copies the folders they chose into `LoomWatch`'s folder
//! (`skills_store.rs`).
//!
//! What it never does: run anything it downloaded, keep a link from a download, write outside
//! the staging folder, or take a skill whose license says "All rights reserved". A download that
//! names a path outside its own folder is refused whole. Downloads are capped at 50 MB, and each
//! skill at 20 MB and 2,000 files.
//!
//! - skills.sh: `GET /api/search?q=` answers `{skills: [{id: "owner/repo/skillId", source:
//!   "owner/repo", skillId, name, installs}]}`. Installing one is a GitHub install of `source`,
//!   keeping the folder whose `SKILL.md` is named `skillId`.
//! - `ClawHub`: `GET /api/v1/search?q=` answers `{results: [{displayName, summary, downloads,
//!   canonicalUrl, install: {kind, reference}}]}`, where `kind` is `clawhub` (`reference` is
//!   `owner/slug`) or `skills-sh` (`skills-sh:owner/repo/skillId`). `GET /api/v1/download?slug=
//!   &ownerHandle=` answers the ZIP, or JSON handing off to a GitHub commit. `GET
//!   /api/v1/skills/{slug}/scan?ownerHandle=` is its safety check, shown when it answers.
//! - GitHub: `owner/repo[/path][@ref]` or a github.com link. The default branch comes from
//!   `api.github.com/repos/{owner}/{repo}` and the commit from its `commits/{ref}`; the files
//!   from `codeload.github.com/{owner}/{repo}/tar.gz/{commit}`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::skills_store::{
    LEFT_BEHIND, LicenseInfo, Limits, NewSkill, Origin, OriginKind, SKILL_FILE, SKIP_DIRECTORIES,
    SkillRecord, SkillsError, SkillsStore, choose_name, describe_size, judge_license_field,
    read_folder, read_skill_text, restricted_reason,
};

/// How long an inspected download waits to be installed.
const STAGED_FOR: Duration = Duration::from_mins(30);
/// Inspected downloads kept at once; the oldest goes first.
const MAX_STAGED: usize = 8;
/// Skill folders one download may offer.
const MAX_CANDIDATES: usize = 200;
const MAX_SEARCH_RESULTS: usize = 30;
const MAX_QUERY: usize = 200;
/// Search answers and API replies are small; anything bigger isn't one.
const MAX_JSON: u64 = 4 * 1024 * 1024;
const API_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// The sites skills come from. Tests point these at a local server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub github_api: String,
    pub codeload: String,
    /// GitHub's own pages, for links the person can open.
    pub github: String,
    pub skills_sh: String,
    pub clawhub: String,
}

impl Endpoints {
    #[must_use]
    pub fn public() -> Self {
        Self {
            github_api: "https://api.github.com".to_owned(),
            codeload: "https://codeload.github.com".to_owned(),
            github: "https://github.com".to_owned(),
            skills_sh: "https://skills.sh".to_owned(),
            clawhub: "https://clawhub.ai".to_owned(),
        }
    }

    fn all_https(&self) -> bool {
        [
            &self.github_api,
            &self.codeload,
            &self.skills_sh,
            &self.clawhub,
        ]
        .iter()
        .all(|base| base.starts_with("https://"))
    }
}

/// Where a skill is installed from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    GitHub,
    SkillsSh,
    ClawHub,
}

impl Source {
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "github" => Some(Self::GitHub),
            "skills.sh" | "skills-sh" | "skillssh" => Some(Self::SkillsSh),
            "clawhub" => Some(Self::ClawHub),
            _ => None,
        }
    }

    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::SkillsSh => "skills.sh",
            Self::ClawHub => "clawhub",
        }
    }

    const fn site(self) -> &'static str {
        match self {
            Self::GitHub => "GitHub",
            Self::SkillsSh => "skills.sh",
            Self::ClawHub => "ClawHub",
        }
    }
}

/// One skill a search found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Where it installs from: `skills.sh` or `clawhub`. A `ClawHub` search can find skills.sh
    /// skills too.
    pub source: &'static str,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installs: Option<u64>,
    /// Its page on the site.
    pub url: String,
    /// What inspect takes, with `source`.
    #[serde(rename = "ref")]
    pub reference: String,
}

/// One skill folder in an inspected download.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCandidate {
    /// Its folder inside the download; `.` when the download is the skill.
    pub path: String,
    pub name: String,
    pub description: String,
    pub license: LicenseInfo,
    pub restricted: bool,
    /// Why it can't be installed, when it can't.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub files: Vec<String>,
    pub has_scripts: bool,
    pub runtimes: Vec<String>,
    pub needs: Vec<String>,
    pub size_bytes: u64,
    /// A skill with this name is already in `LoomWatch`; installing replaces it only when asked.
    pub conflict: bool,
}

/// `ClawHub`'s own safety check of a skill, when it has one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    /// `clean`, `suspicious`, `pending` or `error`: a `malicious` one is never offered.
    pub status: String,
    pub has_warnings: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// What an inspect found, held under `token` until it is installed or expires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub token: String,
    pub source: &'static str,
    /// What was fetched, as the person would name it: `owner/repo`, `owner/slug`.
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan: Option<Scan>,
    /// Things worth knowing that aren't about one skill: links left out, skills not shown.
    pub notes: Vec<String>,
    pub candidates: Vec<InstallCandidate>,
}

#[derive(Debug, Clone)]
struct Staged {
    folder: PathBuf,
    candidates: Vec<InstallCandidate>,
    origin: Origin,
    /// The GitHub page of the commit, for a link to each installed skill.
    tree: Option<String>,
    created: Instant,
}

/// Search, inspect and install. One per daemon; inspected downloads live in it.
#[derive(Debug)]
pub struct Marketplace {
    client: Option<reqwest::Client>,
    endpoints: Endpoints,
    staged: Mutex<BTreeMap<String, Staged>>,
}

impl Marketplace {
    /// No request is made until one is asked for.
    #[must_use]
    pub fn new(endpoints: Endpoints) -> Self {
        let client = reqwest::Client::builder()
            .user_agent(format!(
                "LoomWatch/{} (+https://github.com/{})",
                env!("CARGO_PKG_VERSION"),
                crate::updates::REPOSITORY
            ))
            .connect_timeout(Duration::from_secs(10))
            .timeout(DOWNLOAD_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(3))
            .https_only(endpoints.all_https())
            .build()
            .inspect_err(|error| eprintln!("warning: installing skills is unavailable: {error}"))
            .ok();
        Self {
            client,
            endpoints,
            staged: Mutex::new(BTreeMap::new()),
        }
    }

    fn staged(&self) -> MutexGuard<'_, BTreeMap<String, Staged>> {
        self.staged.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Search skills.sh or `ClawHub`.
    ///
    /// # Errors
    /// When the site can't be reached or answers something unusable.
    pub async fn search(
        &self,
        query: &str,
        source: Source,
    ) -> Result<Vec<SearchResult>, SkillsError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        if query.chars().count() > MAX_QUERY || query.chars().any(char::is_control) {
            return Err(SkillsError::Invalid(
                "Search with a few words instead.".to_owned(),
            ));
        }
        let mut results = match source {
            Source::SkillsSh => {
                let url = format!("{}/api/search", self.endpoints.skills_sh);
                let answer = self.json(&url, &[("q", query)], source).await?;
                skills_sh_results(&answer, &self.endpoints.skills_sh)
            }
            Source::ClawHub => {
                let url = format!("{}/api/v1/search", self.endpoints.clawhub);
                let answer = self
                    .json(&url, &[("q", query), ("limit", "25")], source)
                    .await?;
                clawhub_results(&answer, &self.endpoints)
            }
            Source::GitHub => {
                return Err(SkillsError::Invalid(
                    "Search works on skills.sh and ClawHub. For GitHub, paste a link instead."
                        .to_owned(),
                ));
            }
        };
        results.truncate(MAX_SEARCH_RESULTS);
        Ok(results)
    }

    /// Download what `reference` names, unpack it into the staging folder and list its skills.
    ///
    /// # Errors
    /// When the reference can't be read, the site can't be reached, the download isn't safe or
    /// holds no skill.
    pub async fn inspect(
        &self,
        store: &SkillsStore,
        reference: &str,
        source: Option<Source>,
    ) -> Result<Inspection, SkillsError> {
        let target = parse_target(reference, source)?;
        let limits = store.limits();
        self.tidy(store);
        let fetched = self.fetch(&target, &limits).await?;
        let token = uuid::Uuid::new_v4().simple().to_string();
        let folder = store.staging().join(format!("inspect-{token}"));
        let present = store.names()?;
        let unpacked = {
            let folder = folder.clone();
            let filter = fetched.filter.clone();
            let archive = fetched.archive;
            let fallback = fetched.fallback_name.clone();
            tokio::task::spawn_blocking(move || {
                unpack(&archive, &folder, &filter, &fallback, &present, &limits)
            })
            .await
            .map_err(|error| SkillsError::Io(format!("Unpacking stopped: {error}")))?
        };
        let unpacked = match unpacked {
            Ok(unpacked) => unpacked,
            Err(error) => {
                let _ = fs::remove_dir_all(&folder);
                return Err(error);
            }
        };
        let mut origin = Origin::new(OriginKind::Installed);
        origin.source = Some(fetched.source.id().to_owned());
        origin.reference = Some(fetched.reference.clone());
        origin.commit = fetched.commit.clone().or(unpacked.commit);
        origin.url.clone_from(&fetched.url);
        let inspection = Inspection {
            token: token.clone(),
            source: fetched.source.id(),
            title: fetched.title,
            url: fetched.url,
            commit: origin.commit.clone(),
            scan: fetched.scan,
            notes: unpacked.notes,
            candidates: unpacked.candidates.clone(),
        };
        let mut staged = self.staged();
        staged.insert(
            token,
            Staged {
                folder,
                candidates: unpacked.candidates,
                origin,
                tree: fetched.tree,
                created: Instant::now(),
            },
        );
        evict(&mut staged, MAX_STAGED);
        Ok(inspection)
    }

    /// Copy the chosen skills of an inspected download into `LoomWatch`'s folder.
    ///
    /// Every choice is checked before anything is copied: a restricted or too-big skill refuses
    /// the whole install, and so does a name already in `LoomWatch` unless `replace` is set.
    ///
    /// # Errors
    /// When the inspect has expired, a choice isn't in it or can't be installed, or the folder
    /// can't be written.
    pub fn install(
        &self,
        store: &SkillsStore,
        token: &str,
        paths: &[String],
        replace: bool,
    ) -> Result<Vec<SkillRecord>, SkillsError> {
        let staged = self
            .staged()
            .get(token)
            .filter(|staged| staged.created.elapsed() < STAGED_FOR)
            .cloned()
            .ok_or_else(|| {
                SkillsError::Invalid(
                    "This look at the skill has expired. Look it up again to install it."
                        .to_owned(),
                )
            })?;
        if paths.is_empty() {
            return Err(SkillsError::Invalid(
                "Choose at least one skill to install.".to_owned(),
            ));
        }
        let mut chosen = Vec::new();
        let mut names = BTreeSet::new();
        for path in paths.iter().collect::<BTreeSet<_>>() {
            let candidate = staged
                .candidates
                .iter()
                .find(|candidate| &candidate.path == path)
                .ok_or_else(|| {
                    SkillsError::Invalid(format!("There’s no skill at {path} in this download."))
                })?;
            if let Some(reason) = &candidate.reason {
                return Err(SkillsError::Refused(reason.clone()));
            }
            if !names.insert(candidate.name.to_lowercase()) {
                return Err(SkillsError::Invalid(format!(
                    "Two of the chosen skills are named “{}”. Choose one of them.",
                    candidate.name
                )));
            }
            chosen.push(candidate);
        }
        if !replace {
            let present = store.names()?;
            let already = chosen
                .iter()
                .filter(|candidate| present.contains(&candidate.name.to_lowercase()))
                .map(|candidate| format!("“{}”", candidate.name))
                .collect::<Vec<_>>();
            if !already.is_empty() {
                return Err(SkillsError::Conflict(format!(
                    "{} {} already in LoomWatch. Replace {}?",
                    already.join(", "),
                    if already.len() == 1 { "is" } else { "are" },
                    if already.len() == 1 { "it" } else { "them" },
                )));
            }
        }
        let files = staged.folder.join("files");
        let mut installed = Vec::new();
        for candidate in chosen {
            let inside = (candidate.path != ".").then_some(candidate.path.as_str());
            let mut origin = staged.origin.clone();
            origin.source_path = inside.map(str::to_owned);
            if let (Some(tree), Some("github")) = (&staged.tree, origin.source.as_deref()) {
                origin.url =
                    Some(inside.map_or_else(|| tree.clone(), |inside| format!("{tree}/{inside}")));
            }
            let source = inside.map_or_else(|| files.clone(), |inside| files.join(inside));
            installed.push(store.add(&NewSkill {
                source: &source,
                name: &candidate.name,
                origin,
                batch_id: None,
                replace,
                inherit_license: Some(&files),
            })?);
        }
        if let Some(staged) = self.staged().remove(token) {
            let _ = fs::remove_dir_all(staged.folder);
        }
        Ok(installed)
    }

    /// Drop inspects that expired, and staging folders a previous run of the daemon left behind.
    fn tidy(&self, store: &SkillsStore) {
        let mut staged = self.staged();
        let expired = staged
            .iter()
            .filter(|(_, held)| held.created.elapsed() >= STAGED_FOR)
            .map(|(token, _)| token.clone())
            .collect::<Vec<_>>();
        for token in expired {
            if let Some(held) = staged.remove(&token) {
                let _ = fs::remove_dir_all(held.folder);
            }
        }
        let held = staged
            .values()
            .map(|held| held.folder.clone())
            .collect::<BTreeSet<_>>();
        // Only old ones: another inspect may be unpacking into a new folder right now, before
        // its token is held.
        if let Ok(entries) = fs::read_dir(store.staging()) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                let ours = name.starts_with("inspect-") || name.starts_with("copy-");
                let old = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .is_ok_and(|modified| modified.elapsed().is_ok_and(|age| age >= STAGED_FOR));
                if ours && old && !held.contains(&path) {
                    let _ = fs::remove_dir_all(path);
                }
            }
        }
    }

    fn client(&self) -> Result<&reqwest::Client, SkillsError> {
        self.client.as_ref().ok_or_else(|| {
            SkillsError::Upstream(
                "LoomWatch can’t make secure connections on this computer, so it can’t install skills."
                    .to_owned(),
            )
        })
    }

    async fn get(
        &self,
        url: &str,
        query: &[(&str, &str)],
        accept: &str,
        timeout: Duration,
        source: Source,
    ) -> Result<reqwest::Response, SkillsError> {
        let url = if query.is_empty() {
            url::Url::parse(url)
        } else {
            url::Url::parse_with_params(url, query)
        }
        .map_err(|_| unreachable(source))?;
        self.client()?
            .get(url)
            .header(reqwest::header::ACCEPT, accept)
            .timeout(timeout)
            .send()
            .await
            .map_err(|_| unreachable(source))
    }

    async fn json(
        &self,
        url: &str,
        query: &[(&str, &str)],
        source: Source,
    ) -> Result<Value, SkillsError> {
        let response = self
            .get(url, query, "application/json", API_TIMEOUT, source)
            .await?;
        if !response.status().is_success() {
            return Err(answered(source, response.status()));
        }
        let bytes = read_capped(response, MAX_JSON, source).await?;
        serde_json::from_slice(&bytes).map_err(|_| unreadable(source))
    }

    async fn fetch(&self, target: &Target, limits: &Limits) -> Result<Fetched, SkillsError> {
        match target {
            Target::GitHub(repo) => self.fetch_github(repo, Source::GitHub, limits).await,
            Target::SkillsSh { repo, skill } => {
                let mut fetched = self.fetch_github(repo, Source::SkillsSh, limits).await?;
                fetched.filter.name = Some(skill.clone());
                fetched.reference = format!("{}/{}/{skill}", repo.owner, repo.repo);
                fetched.title = format!("{} from {}/{}", skill, repo.owner, repo.repo);
                fetched.url = Some(format!(
                    "{}/{}/{}/{skill}",
                    self.endpoints.skills_sh, repo.owner, repo.repo
                ));
                Ok(fetched)
            }
            Target::ClawHub { owner, slug } => self.fetch_clawhub(owner, slug, limits).await,
        }
    }

    async fn fetch_github(
        &self,
        repo: &GitHubRef,
        source: Source,
        limits: &Limits,
    ) -> Result<Fetched, SkillsError> {
        let reference = match &repo.reference {
            Some(reference) => reference.clone(),
            // When GitHub's API is busy, codeload still knows the default branch as HEAD.
            None => self
                .default_branch(repo, source)
                .await?
                .unwrap_or_else(|| "HEAD".to_owned()),
        };
        let commit = self.commit_of(repo, &reference, source).await;
        let at = commit.as_deref().unwrap_or(&reference);
        let url = format!(
            "{}/{}/{}/tar.gz/{at}",
            self.endpoints.codeload, repo.owner, repo.repo
        );
        let archive = self.download(&url, &[], source, limits).await?;
        let page = format!(
            "{}/{}/{}/tree/{at}",
            self.endpoints.github, repo.owner, repo.repo
        );
        let shown = repo.path.as_ref().map_or_else(
            || format!("{}/{}", repo.owner, repo.repo),
            |path| format!("{}/{}/{path}", repo.owner, repo.repo),
        );
        Ok(Fetched {
            source,
            reference: if repo.reference.is_some() {
                format!("{shown}@{reference}")
            } else {
                shown.clone()
            },
            title: shown,
            url: Some(
                repo.path
                    .as_ref()
                    .map_or_else(|| page.clone(), |path| format!("{page}/{path}")),
            ),
            commit,
            scan: None,
            archive: Archive::Tar(archive),
            filter: Filter {
                path: repo.path.clone(),
                name: None,
            },
            tree: Some(page),
            fallback_name: repo.repo.clone(),
        })
    }

    /// `Ok(None)` when GitHub's API is limiting requests or answering errors: the download can
    /// still go ahead.
    async fn default_branch(
        &self,
        repo: &GitHubRef,
        source: Source,
    ) -> Result<Option<String>, SkillsError> {
        let url = format!(
            "{}/repos/{}/{}",
            self.endpoints.github_api, repo.owner, repo.repo
        );
        let response = self
            .get(
                &url,
                &[],
                "application/vnd.github+json",
                API_TIMEOUT,
                source,
            )
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(SkillsError::NotFound(format!(
                "GitHub can’t find {}/{}. Check the link. Private repositories can’t be installed.",
                repo.owner, repo.repo
            )));
        }
        if !response.status().is_success() {
            return Ok(None);
        }
        let Ok(bytes) = read_capped(response, MAX_JSON, source).await else {
            return Ok(None);
        };
        Ok(serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| value["default_branch"].as_str().map(str::to_owned))
            .filter(|branch| plain_ref(branch)))
    }

    /// The commit `reference` names, so the record says exactly what was installed.
    async fn commit_of(&self, repo: &GitHubRef, reference: &str, source: Source) -> Option<String> {
        let url = format!(
            "{}/repos/{}/{}/commits/{reference}",
            self.endpoints.github_api, repo.owner, repo.repo
        );
        let response = self
            .get(&url, &[], "application/vnd.github.sha", API_TIMEOUT, source)
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let bytes = read_capped(response, 1024, source).await.ok()?;
        let sha = String::from_utf8(bytes).ok()?.trim().to_owned();
        is_commit(&sha).then_some(sha)
    }

    async fn fetch_clawhub(
        &self,
        owner: &str,
        slug: &str,
        limits: &Limits,
    ) -> Result<Fetched, SkillsError> {
        let source = Source::ClawHub;
        let page = format!("{}/{owner}/skills/{slug}", self.endpoints.clawhub);
        let scan = self.clawhub_scan(owner, slug, &page).await?;
        let url = format!("{}/api/v1/download", self.endpoints.clawhub);
        let query = [("slug", slug), ("ownerHandle", owner)];
        let response = self
            .get(
                &url,
                &query,
                "application/zip, application/json",
                DOWNLOAD_TIMEOUT,
                source,
            )
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(SkillsError::NotFound(format!(
                "ClawHub can’t find {owner}/{slug}. Check the name, or search for it."
            )));
        }
        if !response.status().is_success() {
            return Err(answered(source, response.status()));
        }
        let json = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("json"));
        let reference = format!("{owner}/{slug}");
        if json {
            // ClawHub hands some skills off to the GitHub commit they live at.
            let bytes = read_capped(response, MAX_JSON, source).await?;
            let handoff: Value = serde_json::from_slice(&bytes).map_err(|_| unreadable(source))?;
            let repo = handoff_repo(&handoff).ok_or_else(|| unreadable(source))?;
            let mut fetched = self.fetch_github(&repo, source, limits).await?;
            fetched.reference.clone_from(&reference);
            fetched.title = reference;
            fetched.url = Some(page);
            fetched.scan = scan;
            slug.clone_into(&mut fetched.fallback_name);
            return Ok(fetched);
        }
        let archive = read_capped(response, limits.download_bytes, source).await?;
        Ok(Fetched {
            source,
            reference: reference.clone(),
            title: reference,
            url: Some(page),
            commit: None,
            scan,
            archive: Archive::Zip(archive),
            filter: Filter::default(),
            tree: None,
            fallback_name: slug.to_owned(),
        })
    }

    /// `ClawHub`'s safety check. One that found harm, or a skill its moderators blocked, stops the
    /// install; one that can't be fetched is left out.
    async fn clawhub_scan(
        &self,
        owner: &str,
        slug: &str,
        page: &str,
    ) -> Result<Option<Scan>, SkillsError> {
        let url = format!("{}/api/v1/skills/{slug}/scan", self.endpoints.clawhub);
        let Ok(answer) = self
            .json(&url, &[("ownerHandle", owner)], Source::ClawHub)
            .await
        else {
            return Ok(None);
        };
        let moderation = &answer["moderation"];
        let security = &answer["security"];
        let status = security["status"].as_str().unwrap_or_default().to_owned();
        if moderation["isMalwareBlocked"].as_bool() == Some(true)
            || moderation["isRemoved"].as_bool() == Some(true)
            || status == "malicious"
        {
            return Err(SkillsError::Refused(format!(
                "ClawHub’s safety check flagged {owner}/{slug} as harmful, so LoomWatch won’t install it."
            )));
        }
        if status.is_empty() {
            return Ok(None);
        }
        Ok(Some(Scan {
            status,
            has_warnings: security["hasWarnings"].as_bool().unwrap_or(false),
            url: Some(page.to_owned()),
        }))
    }

    async fn download(
        &self,
        url: &str,
        query: &[(&str, &str)],
        source: Source,
        limits: &Limits,
    ) -> Result<Vec<u8>, SkillsError> {
        let response = self
            .get(url, query, "*/*", DOWNLOAD_TIMEOUT, source)
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(SkillsError::NotFound(format!(
                "{} can’t find that. Check the link, and that the branch or tag exists.",
                source.site()
            )));
        }
        if !response.status().is_success() {
            return Err(answered(source, response.status()));
        }
        read_capped(response, limits.download_bytes, source).await
    }
}

/// Drop the oldest inspects past `keep`.
fn evict(staged: &mut BTreeMap<String, Staged>, keep: usize) {
    while staged.len() > keep {
        let Some(oldest) = staged
            .iter()
            .min_by_key(|(_, held)| held.created)
            .map(|(token, _)| token.clone())
        else {
            return;
        };
        if let Some(held) = staged.remove(&oldest) {
            let _ = fs::remove_dir_all(held.folder);
        }
    }
}

fn unreachable(source: Source) -> SkillsError {
    SkillsError::Upstream(format!(
        "Couldn’t reach {}. Check your internet connection and try again.",
        source.site()
    ))
}

fn unreadable(source: Source) -> SkillsError {
    SkillsError::Upstream(format!(
        "{} answered something LoomWatch can’t read. Try again later.",
        source.site()
    ))
}

fn answered(source: Source, status: reqwest::StatusCode) -> SkillsError {
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        return SkillsError::Upstream(format!(
            "{} is limiting requests right now. Try again in a few minutes.",
            source.site()
        ));
    }
    SkillsError::Upstream(format!(
        "{} couldn’t answer (error {}). Try again later.",
        source.site(),
        status.as_u16()
    ))
}

/// The whole body, refused once it passes `limit`.
async fn read_capped(
    mut response: reqwest::Response,
    limit: u64,
    source: Source,
) -> Result<Vec<u8>, SkillsError> {
    let too_big = || {
        SkillsError::Refused(format!(
            "The download is bigger than LoomWatch takes ({}).",
            describe_size(limit)
        ))
    };
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(too_big());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unreachable(source))? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > limit {
            return Err(too_big());
        }
    }
    Ok(bytes)
}

fn skills_sh_results(answer: &Value, base: &str) -> Vec<SearchResult> {
    let Some(skills) = answer["skills"].as_array() else {
        return Vec::new();
    };
    skills
        .iter()
        .filter_map(|skill| {
            let id = skill["id"].as_str()?;
            // Only what an install can follow: `owner/repo/skillId`.
            let Ok(Target::SkillsSh { .. }) = parse_target(id, Some(Source::SkillsSh)) else {
                return None;
            };
            Some(SearchResult {
                source: Source::SkillsSh.id(),
                id: id.to_owned(),
                name: skill["name"]
                    .as_str()
                    .or_else(|| skill["skillId"].as_str())
                    .unwrap_or(id)
                    .to_owned(),
                description: skill["description"].as_str().map(str::to_owned),
                installs: skill["installs"].as_u64(),
                url: format!("{base}/{id}"),
                reference: id.to_owned(),
            })
        })
        .collect()
}

fn clawhub_results(answer: &Value, endpoints: &Endpoints) -> Vec<SearchResult> {
    let Some(results) = answer["results"].as_array() else {
        return Vec::new();
    };
    results
        .iter()
        .filter_map(|result| {
            let installability = result["trust"]["installability"].as_str();
            if installability.is_some_and(|value| value != "installable") {
                return None;
            }
            let install = &result["install"];
            let reference = install["reference"].as_str()?;
            let (source, reference) = match install["kind"].as_str()? {
                "clawhub" => (Source::ClawHub, reference),
                "skills-sh" => (
                    Source::SkillsSh,
                    reference.strip_prefix("skills-sh:").unwrap_or(reference),
                ),
                _ => return None,
            };
            parse_target(reference, Some(source)).ok()?;
            let url = result["canonicalUrl"]
                .as_str()
                .filter(|path| path.starts_with('/'))
                .map(|path| format!("{}{path}", endpoints.clawhub))
                .or_else(|| install["sourceUrl"].as_str().map(str::to_owned))
                .unwrap_or_else(|| format!("{}/{reference}", endpoints.clawhub));
            Some(SearchResult {
                source: source.id(),
                id: result["id"].as_str().unwrap_or(reference).to_owned(),
                name: result["displayName"]
                    .as_str()
                    .or_else(|| result["slug"].as_str())
                    .unwrap_or(reference)
                    .to_owned(),
                description: result["summary"]
                    .as_str()
                    .filter(|summary| !summary.trim().is_empty())
                    .map(str::to_owned),
                installs: result["downloads"].as_u64(),
                url,
                reference: reference.to_owned(),
            })
        })
        .collect()
}

/// A handoff's GitHub commit and folder, checked like anything else pasted in.
fn handoff_repo(handoff: &Value) -> Option<GitHubRef> {
    let repo = handoff["repo"].as_str()?;
    let commit = handoff["commit"]
        .as_str()
        .filter(|commit| is_commit(commit))?;
    let Ok(Target::GitHub(mut parsed)) = parse_target(repo, Some(Source::GitHub)) else {
        return None;
    };
    parsed.reference = Some(commit.to_owned());
    parsed.path = match handoff["path"].as_str().map(str::trim) {
        None | Some("" | "." | "/") => None,
        Some(path) => Some(clean_path_text(path)?),
    };
    Some(parsed)
}

// --- What the person asked for ------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitHubRef {
    owner: String,
    repo: String,
    /// A folder inside the repository: only skills in it are offered.
    path: Option<String>,
    reference: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Target {
    GitHub(GitHubRef),
    /// A skills.sh skill: its repository, and the skill's name in it.
    SkillsSh {
        repo: GitHubRef,
        skill: String,
    },
    ClawHub {
        owner: String,
        slug: String,
    },
}

fn invalid_link() -> SkillsError {
    SkillsError::Invalid(
        "LoomWatch can’t read that. Paste a GitHub link such as github.com/owner/repo, or owner/repo."
            .to_owned(),
    )
}

/// Read a pasted reference: `owner/repo[/path][@ref]`, a github.com, skills.sh or clawhub.ai
/// link, a skills.sh id `owner/repo/skill`, or a `ClawHub` `owner/slug`.
fn parse_target(reference: &str, source: Option<Source>) -> Result<Target, SkillsError> {
    let text = reference.trim();
    if text.is_empty() || text.len() > 500 || text.chars().any(char::is_control) {
        return Err(invalid_link());
    }
    let lower = text.to_ascii_lowercase();
    let link = lower.contains("://")
        || [
            "github.com/",
            "www.github.com/",
            "skills.sh/",
            "www.skills.sh/",
            "clawhub.ai/",
            "www.clawhub.ai/",
        ]
        .iter()
        .any(|host| lower.starts_with(host));
    if link {
        return parse_link(text);
    }
    match source {
        Some(Source::ClawHub) => {
            let parts = segments(text).ok_or_else(invalid_link)?;
            match parts.as_slice() {
                [owner, slug] | [owner, _, slug] if plain_word(owner) && plain_word(slug) => {
                    Ok(Target::ClawHub {
                        owner: (*owner).to_owned(),
                        slug: (*slug).to_owned(),
                    })
                }
                _ => Err(invalid_link()),
            }
        }
        Some(Source::SkillsSh) => {
            let text = text.strip_prefix("skills-sh:").unwrap_or(text);
            let parts = segments(text).ok_or_else(invalid_link)?;
            match parts.as_slice() {
                [owner, repo, skill] if plain_word(skill) => Ok(Target::SkillsSh {
                    repo: github_ref(owner, repo, &[], None)?,
                    skill: (*skill).to_owned(),
                }),
                _ => Err(invalid_link()),
            }
        }
        Some(Source::GitHub) | None => {
            let (path, reference) = match text.rsplit_once('@') {
                Some((path, reference)) => (path, Some(reference)),
                None => (text, None),
            };
            let parts = segments(path).ok_or_else(invalid_link)?;
            match parts.as_slice() {
                [owner, repo, rest @ ..] => {
                    Ok(Target::GitHub(github_ref(owner, repo, rest, reference)?))
                }
                _ => Err(invalid_link()),
            }
        }
    }
}

fn parse_link(text: &str) -> Result<Target, SkillsError> {
    let with_scheme = if text.contains("://") {
        text.to_owned()
    } else {
        format!("https://{text}")
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| invalid_link())?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err(invalid_link());
    }
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_start_matches("www.");
    let path = url.path().trim_matches('/');
    let parts = segments(path).ok_or_else(invalid_link)?;
    match host {
        "github.com" => match parts.as_slice() {
            [owner, repo] => Ok(Target::GitHub(github_ref(owner, repo, &[], None)?)),
            [owner, repo, "tree" | "blob", reference, rest @ ..] => {
                let mut rest = rest.to_vec();
                if rest.last().is_some_and(|last| last.eq_ignore_ascii_case(SKILL_FILE)) {
                    rest.pop();
                }
                Ok(Target::GitHub(github_ref(owner, repo, &rest, Some(reference))?))
            }
            _ => Err(invalid_link()),
        },
        "skills.sh" => match parts.as_slice() {
            [owner, repo, skill] if plain_word(skill) => Ok(Target::SkillsSh {
                repo: github_ref(owner, repo, &[], None)?,
                skill: (*skill).to_owned(),
            }),
            _ => Err(invalid_link()),
        },
        "clawhub.ai" => match parts.as_slice() {
            [owner, "skills", slug] | [owner, slug] if plain_word(owner) && plain_word(slug) => {
                Ok(Target::ClawHub {
                    owner: (*owner).to_owned(),
                    slug: (*slug).to_owned(),
                })
            }
            _ => Err(invalid_link()),
        },
        _ => Err(SkillsError::Invalid(
            "LoomWatch installs skills from GitHub, skills.sh and ClawHub. Paste a link from one of those."
                .to_owned(),
        )),
    }
}

/// The parts of a `/`-separated path, refusing empty, `.` and `..` parts.
fn segments(text: &str) -> Option<Vec<&str>> {
    let text = text.trim_matches('/');
    let parts = text.split('/').collect::<Vec<_>>();
    parts
        .iter()
        .all(|part| !part.is_empty() && *part != "." && *part != ".." && !part.contains('\\'))
        .then_some(parts)
}

/// Letters, digits, `-`, `_` and `.`, not starting with a dot: safe in any URL path.
fn plain_word(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 128
        && !text.starts_with('.')
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn plain_ref(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 200
        && !text.starts_with(['-', '/', '.'])
        && !text.ends_with('/')
        && !text.contains("..")
        && !text.contains("//")
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
}

fn is_commit(text: &str) -> bool {
    (7..=64).contains(&text.len()) && text.chars().all(|c| c.is_ascii_hexdigit())
}

fn github_ref(
    owner: &str,
    repo: &str,
    rest: &[&str],
    reference: Option<&str>,
) -> Result<GitHubRef, SkillsError> {
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if !plain_word(owner) || !plain_word(repo) {
        return Err(invalid_link());
    }
    if rest
        .iter()
        .any(|part| part.chars().any(char::is_control) || part.contains(['\\', '\0']))
    {
        return Err(invalid_link());
    }
    let reference = reference
        .map(str::trim)
        .filter(|reference| !reference.is_empty());
    if reference.is_some_and(|reference| !plain_ref(reference)) {
        return Err(SkillsError::Invalid(
            "That branch or tag name can’t be used. Leave out the @ to install the main branch."
                .to_owned(),
        ));
    }
    Ok(GitHubRef {
        owner: owner.to_owned(),
        repo: repo.to_owned(),
        path: (!rest.is_empty()).then(|| rest.join("/")),
        reference: reference.map(str::to_owned),
    })
}

// --- Unpacking ---------------------------------------------------------------------------------

enum Archive {
    /// A `.tar.gz` from GitHub, whose files sit in one top folder named for the commit.
    Tar(Vec<u8>),
    Zip(Vec<u8>),
}

/// Which skill folders of a download to offer.
#[derive(Debug, Clone, Default)]
struct Filter {
    /// Only skills in this folder.
    path: Option<String>,
    /// Only the skill with this name, when the download has one by it.
    name: Option<String>,
}

struct Fetched {
    source: Source,
    reference: String,
    title: String,
    url: Option<String>,
    commit: Option<String>,
    scan: Option<Scan>,
    archive: Archive,
    filter: Filter,
    /// A GitHub download's page of the commit.
    tree: Option<String>,
    /// The name for a skill whose download is the skill itself and whose `SKILL.md` names none.
    fallback_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Link,
    Other,
}

#[derive(Debug, Clone)]
struct Listed {
    index: usize,
    /// Clean, relative, `/`-separated; never empty.
    path: String,
    size: u64,
    kind: Kind,
    executable: bool,
}

struct Unpacked {
    candidates: Vec<InstallCandidate>,
    notes: Vec<String>,
    /// The commit a GitHub archive says it was made from.
    commit: Option<String>,
}

fn unsafe_download() -> SkillsError {
    SkillsError::Refused(
        "This download has a file that tries to reach outside its own folder, so LoomWatch won’t use it."
            .to_owned(),
    )
}

/// A path from inside a download, made relative and `/`-separated. `Err` when it is absolute or
/// climbs out with `..`, `Ok(None)` when nothing is left of it.
fn clean_entry_path(raw: &str) -> Result<Option<String>, SkillsError> {
    if raw.contains('\0') || raw.starts_with(['/', '\\']) {
        return Err(unsafe_download());
    }
    let mut parts = Vec::new();
    for part in raw.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => return Err(unsafe_download()),
            // `C:` names a drive on Windows.
            part if parts.is_empty() && part.len() == 2 && part.ends_with(':') => {
                return Err(unsafe_download());
            }
            part => parts.push(part),
        }
    }
    Ok((!parts.is_empty()).then(|| parts.join("/")))
}

fn clean_path_text(text: &str) -> Option<String> {
    clean_entry_path(text).ok().flatten()
}

/// The decompressed stream, stopped past `limit` so an archive that inflates without end can't
/// keep the daemon busy.
struct Capped<R> {
    inner: R,
    left: u64,
}

impl<R: Read> Read for Capped<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.left = self
            .left
            .checked_sub(read as u64)
            .ok_or_else(|| io::Error::other("the download unpacks to more than LoomWatch takes"))?;
        Ok(read)
    }
}

fn tar_reader<'a>(
    bytes: &'a [u8],
    limits: &Limits,
) -> tar::Archive<Capped<flate2::read::GzDecoder<&'a [u8]>>> {
    tar::Archive::new(Capped {
        inner: flate2::read::GzDecoder::new(bytes),
        left: limits.unpacked_bytes.saturating_mul(5),
    })
}

fn broken_download(error: impl std::fmt::Display) -> SkillsError {
    SkillsError::Refused(format!("The download can’t be unpacked: {error}."))
}

/// What the first pass over a download found.
struct Listing {
    entries: Vec<Listed>,
    /// Each `SKILL.md`'s text, by its path.
    texts: BTreeMap<String, String>,
    /// The commit a GitHub archive says it was made from.
    commit: Option<String>,
}

/// Every entry of a GitHub tarball, with its top folder taken off, and the `SKILL.md` texts.
fn list_tar(bytes: &[u8], limits: &Limits) -> Result<Listing, SkillsError> {
    let mut archive = tar_reader(bytes, limits);
    let mut listed = Vec::new();
    let mut texts = BTreeMap::new();
    let mut commit = None;
    for (index, entry) in archive.entries().map_err(broken_download)?.enumerate() {
        let mut entry = entry.map_err(broken_download)?;
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions() {
            // git archive writes the commit it was made from here, as `comment`.
            let mut text = String::new();
            let _ = entry.by_ref().take(4096).read_to_string(&mut text);
            commit = text
                .lines()
                .find_map(|line| {
                    line.split_once("comment=")
                        .map(|(_, sha)| sha.trim().to_owned())
                })
                .filter(|sha| is_commit(sha));
            continue;
        }
        let raw = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
        let Some(path) = clean_entry_path(&raw)? else {
            continue;
        };
        // Everything sits in `<repo>-<commit>/`; a file beside that folder isn't the repository's.
        let Some((_, path)) = path.split_once('/') else {
            continue;
        };
        let kind = if kind.is_file() {
            Kind::File
        } else if kind.is_symlink() || kind.is_hard_link() {
            Kind::Link
        } else {
            Kind::Other
        };
        let size = entry.size();
        if kind == Kind::File && is_skill_file(path) {
            let mut text = String::new();
            let _ = entry.by_ref().take(1024 * 1024).read_to_string(&mut text);
            texts.insert(path.to_owned(), text);
        }
        let executable = entry.header().mode().is_ok_and(|mode| mode & 0o111 != 0);
        listed.push(Listed {
            index,
            path: path.to_owned(),
            size,
            kind,
            executable,
        });
    }
    Ok(Listing {
        entries: listed,
        texts,
        commit,
    })
}

fn extract_tar(
    bytes: &[u8],
    wanted: &BTreeMap<usize, (String, bool)>,
    root: &Path,
    limits: &Limits,
) -> Result<(), SkillsError> {
    let mut archive = tar_reader(bytes, limits);
    for (index, entry) in archive.entries().map_err(broken_download)?.enumerate() {
        let mut entry = entry.map_err(broken_download)?;
        if let Some((path, executable)) = wanted.get(&index) {
            write_file(root, path, &mut entry, *executable, limits)?;
        }
    }
    Ok(())
}

fn zip_reader(bytes: &[u8]) -> Result<zip::ZipArchive<Cursor<&[u8]>>, SkillsError> {
    zip::ZipArchive::new(Cursor::new(bytes)).map_err(broken_download)
}

/// Every entry of a ZIP, and the `SKILL.md` texts.
fn list_zip(bytes: &[u8]) -> Result<Listing, SkillsError> {
    let mut archive = zip_reader(bytes)?;
    let mut listed = Vec::new();
    let mut texts = BTreeMap::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(broken_download)?;
        let raw = file.name().map_err(broken_download)?.into_owned();
        let Some(path) = clean_entry_path(&raw)? else {
            continue;
        };
        if file.enclosed_name().is_none() {
            return Err(unsafe_download());
        }
        let kind = if file.is_symlink() {
            Kind::Link
        } else if file.is_file() {
            Kind::File
        } else {
            Kind::Other
        };
        if kind == Kind::File && is_skill_file(&path) {
            let mut text = String::new();
            let _ = file.by_ref().take(1024 * 1024).read_to_string(&mut text);
            texts.insert(path.clone(), text);
        }
        let executable = file.unix_mode().is_some_and(|mode| mode & 0o111 != 0);
        listed.push(Listed {
            index,
            path,
            size: file.size(),
            kind,
            executable,
        });
    }
    Ok(Listing {
        entries: listed,
        texts,
        commit: None,
    })
}

fn extract_zip(
    bytes: &[u8],
    wanted: &BTreeMap<usize, (String, bool)>,
    root: &Path,
    limits: &Limits,
) -> Result<(), SkillsError> {
    let mut archive = zip_reader(bytes)?;
    for (index, (path, executable)) in wanted {
        let mut file = archive.by_index(*index).map_err(broken_download)?;
        write_file(root, path, &mut file, *executable, limits)?;
    }
    Ok(())
}

/// Write one file of a download under `root`. `path` is already clean and relative, and nothing
/// under `root` is a link, so the file lands where its path says.
fn write_file(
    root: &Path,
    path: &str,
    reader: &mut impl Read,
    executable: bool,
    limits: &Limits,
) -> Result<(), SkillsError> {
    let target = root.join(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|_| unsafe_download())?;
    }
    let mut file = fs::File::create(&target)?;
    // A file may say it is smaller than it is; reading stops past what one skill may hold.
    let written = io::copy(&mut reader.take(limits.skill_bytes + 1), &mut file)?;
    if written > limits.skill_bytes {
        return Err(SkillsError::Refused(limits.too_big()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if executable { 0o755 } else { 0o644 };
        fs::set_permissions(&target, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(())
}

fn is_skill_file(path: &str) -> bool {
    path.rsplit('/').next() == Some(SKILL_FILE)
}

fn is_license_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("license") || lower.starts_with("licence") || lower.starts_with("copying")
}

/// `path` is `folder` or inside it; `""` is the whole download.
fn within(path: &str, folder: &str) -> bool {
    folder.is_empty()
        || path == folder
        || path
            .strip_prefix(folder)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Inside a folder never copied with a skill (`.git`, `node_modules`), counted from `folder`.
fn left_behind(path: &str, folder: &str) -> bool {
    let rest = if folder.is_empty() {
        path
    } else {
        path.strip_prefix(folder)
            .map_or(path, |rest| rest.trim_start_matches('/'))
    };
    rest.split('/').any(|part| LEFT_BEHIND.contains(&part))
}

struct Planned {
    folder: String,
    text: String,
    too_big: bool,
}

/// Unpack the skill folders of a download into `<folder>/files` and describe each.
///
/// Two passes: the first reads every entry's path and size (and each `SKILL.md`) to find the
/// skill folders, the second writes only the files of the skills offered, so a big repository
/// with one small skill unpacks only that skill.
#[allow(clippy::too_many_lines)]
fn unpack(
    archive: &Archive,
    folder: &Path,
    filter: &Filter,
    fallback: &str,
    present: &BTreeSet<String>,
    limits: &Limits,
) -> Result<Unpacked, SkillsError> {
    let Listing {
        entries: listed,
        texts,
        commit,
    } = match archive {
        Archive::Tar(bytes) => list_tar(bytes, limits)?,
        Archive::Zip(bytes) => list_zip(bytes)?,
    };
    let mut notes = Vec::new();
    let mut folders = texts
        .keys()
        .map(|path| {
            path.rsplit_once('/')
                .map_or("", |(folder, _)| folder)
                .to_owned()
        })
        .filter(|folder| {
            !folder
                .split('/')
                .any(|part| SKIP_DIRECTORIES.contains(&part))
        })
        .collect::<Vec<_>>();
    if let Some(path) = &filter.path {
        folders.retain(|folder| within(folder, path));
        if folders.is_empty() {
            return Err(SkillsError::NotFound(format!(
                "There’s no skill in {path}. A skill is a folder with a SKILL.md file in it."
            )));
        }
    }
    if let Some(name) = &filter.name {
        let named = folders
            .iter()
            .filter(|folder| {
                let declared = read_skill_text(&texts[&skill_path(folder)]).name;
                declared.is_some_and(|declared| declared.eq_ignore_ascii_case(name))
                    || folder
                        .rsplit('/')
                        .next()
                        .is_some_and(|last| last.eq_ignore_ascii_case(name))
            })
            .cloned()
            .collect::<Vec<_>>();
        if !named.is_empty() {
            folders = named;
        }
    }
    if folders.is_empty() {
        return Err(SkillsError::NotFound(
            "There’s no skill in this download. A skill is a folder with a SKILL.md file in it."
                .to_owned(),
        ));
    }
    if folders.len() > MAX_CANDIDATES {
        notes.push(format!(
            "This download has {} skills; the first {MAX_CANDIDATES} are shown.",
            folders.len()
        ));
        folders.truncate(MAX_CANDIDATES);
    }

    let mut wanted = BTreeMap::new();
    let mut planned = Vec::new();
    let mut links = 0usize;
    for skill in &folders {
        let inside = listed
            .iter()
            .filter(|entry| within(&entry.path, skill) && !left_behind(&entry.path, skill))
            .collect::<Vec<_>>();
        links += inside
            .iter()
            .filter(|entry| entry.kind == Kind::Link)
            .count();
        let files = inside
            .iter()
            .filter(|entry| entry.kind == Kind::File)
            .collect::<Vec<_>>();
        let bytes = files.iter().map(|entry| entry.size).sum::<u64>();
        let too_big = files.len() > limits.skill_files || bytes > limits.skill_bytes;
        if !too_big {
            for entry in files {
                wanted.insert(entry.index, (entry.path.clone(), entry.executable));
            }
        }
        planned.push(Planned {
            folder: skill.clone(),
            text: texts[&skill_path(skill)].clone(),
            too_big,
        });
    }
    // The repository's own license covers a skill that has none.
    for entry in &listed {
        if entry.kind == Kind::File && !entry.path.contains('/') && is_license_file(&entry.path) {
            wanted.insert(entry.index, (entry.path.clone(), false));
        }
    }
    let total = listed
        .iter()
        .filter(|entry| wanted.contains_key(&entry.index))
        .map(|entry| entry.size)
        .sum::<u64>();
    if total > limits.unpacked_bytes {
        return Err(SkillsError::Refused(format!(
            "These skills unpack to more than LoomWatch takes ({}).",
            describe_size(limits.unpacked_bytes)
        )));
    }
    if links > 0 {
        notes.push(if links == 1 {
            "1 link in the download was left out.".to_owned()
        } else {
            format!("{links} links in the download were left out.")
        });
    }

    let root = folder.join("files");
    fs::create_dir_all(&root)?;
    match archive {
        Archive::Tar(bytes) => extract_tar(bytes, &wanted, &root, limits)?,
        Archive::Zip(bytes) => extract_zip(bytes, &wanted, &root, limits)?,
    }

    let mut candidates = Vec::new();
    for plan in planned {
        let last = plan
            .folder
            .rsplit('/')
            .next()
            .filter(|last| !last.is_empty())
            .unwrap_or(fallback);
        let directory = if plan.folder.is_empty() {
            root.clone()
        } else {
            root.join(&plan.folder)
        };
        let inherit = (!plan.folder.is_empty()).then_some(root.as_path());
        let path = if plan.folder.is_empty() {
            ".".to_owned()
        } else {
            plan.folder.clone()
        };
        let candidate = if plan.too_big {
            let text = read_skill_text(&plan.text);
            let name = choose_name(text.name.as_deref(), last);
            let license = text
                .license
                .as_deref()
                .map(judge_license_field)
                .unwrap_or_default();
            InstallCandidate {
                conflict: present.contains(&name.to_lowercase()),
                reason: Some(if license.restricted {
                    restricted_reason(&name)
                } else {
                    limits.too_big()
                }),
                restricted: license.restricted,
                path,
                name,
                description: text.description,
                license,
                files: Vec::new(),
                has_scripts: false,
                runtimes: Vec::new(),
                needs: text.needs,
                size_bytes: 0,
            }
        } else {
            let facts = read_folder(&directory, last, inherit, limits)?;
            InstallCandidate {
                conflict: present.contains(&facts.name.to_lowercase()),
                reason: facts.refusal(limits),
                restricted: facts.license.restricted,
                path,
                name: facts.name,
                description: facts.description,
                license: facts.license,
                files: facts.files,
                has_scripts: facts.has_scripts,
                runtimes: facts.runtimes,
                needs: facts.needs,
                size_bytes: facts.size_bytes,
            }
        };
        candidates.push(candidate);
    }
    Ok(Unpacked {
        candidates,
        notes,
        commit,
    })
}

fn skill_path(folder: &str) -> String {
    if folder.is_empty() {
        SKILL_FILE.to_owned()
    } else {
        format!("{folder}/{SKILL_FILE}")
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::sync::Arc;

    use axum::Router;
    use axum::http::{StatusCode, Uri, header};
    use axum::response::IntoResponse;

    use super::*;
    use crate::skills_store::tests::{Scratch, small_limits};

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
    const MIT: &str = "MIT License\n\nPermission is hereby granted, free of charge, to any person…";

    type Answers = Arc<Mutex<BTreeMap<String, (StatusCode, &'static str, Vec<u8>)>>>;

    /// A stand-in for GitHub, codeload, skills.sh and `ClawHub` on one local port: each path
    /// answers what the test put under it, and every request is kept.
    #[derive(Clone, Default)]
    struct FakeSites {
        answers: Answers,
        requests: Arc<Mutex<Vec<String>>>,
    }

    impl FakeSites {
        fn answer(&self, path: &str, content_type: &'static str, body: impl Into<Vec<u8>>) {
            self.answers
                .lock()
                .unwrap()
                .insert(path.to_owned(), (StatusCode::OK, content_type, body.into()));
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }

    async fn fake_sites() -> (FakeSites, Endpoints) {
        let sites = FakeSites::default();
        let serving = sites.clone();
        let app = Router::new().fallback(move |uri: Uri| {
            let sites = serving.clone();
            async move {
                sites.requests.lock().unwrap().push(uri.to_string());
                let answer = sites.answers.lock().unwrap().get(uri.path()).cloned();
                match answer {
                    Some((status, content_type, body)) => {
                        (status, [(header::CONTENT_TYPE, content_type)], body).into_response()
                    }
                    None => StatusCode::NOT_FOUND.into_response(),
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let base = format!("http://{address}");
        let endpoints = Endpoints {
            github_api: format!("{base}/gh"),
            codeload: format!("{base}/codeload"),
            github: format!("{base}/web"),
            skills_sh: format!("{base}/ss"),
            clawhub: format!("{base}/ch"),
        };
        (sites, endpoints)
    }

    #[derive(Clone, Copy)]
    enum Entry<'a> {
        File(&'a str, &'a [u8]),
        Script(&'a str, &'a [u8]),
        Symlink(&'a str, &'a str),
        HardLink(&'a str, &'a str),
        /// A file whose name is written into the header as given, unchecked.
        Raw(&'a str, &'a [u8]),
    }

    /// A gzip'd tar the way codeload makes one: a pax header naming the commit, then everything
    /// in one top folder.
    fn tarball(top: &str, entries: &[Entry<'_>]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        let comment = format!("52 comment={SHA}\n");
        let mut pax = tar::Header::new_ustar();
        pax.set_entry_type(tar::EntryType::XGlobalHeader);
        pax.set_path("pax_global_header").unwrap();
        pax.set_size(comment.len() as u64);
        pax.set_cksum();
        builder.append(&pax, comment.as_bytes()).unwrap();
        for entry in entries {
            let mut header = tar::Header::new_gnu();
            let (name, kind, mode, data, link): (&str, tar::EntryType, u32, &[u8], Option<&str>) =
                match *entry {
                    Entry::File(name, data) | Entry::Raw(name, data) => {
                        (name, tar::EntryType::Regular, 0o644, data, None)
                    }
                    Entry::Script(name, data) => (name, tar::EntryType::Regular, 0o755, data, None),
                    Entry::Symlink(name, target) => {
                        (name, tar::EntryType::Symlink, 0o777, &[], Some(target))
                    }
                    Entry::HardLink(name, target) => {
                        (name, tar::EntryType::Link, 0o644, &[], Some(target))
                    }
                };
            let full = if matches!(entry, Entry::Raw(..)) {
                name.to_owned()
            } else {
                format!("{top}/{name}")
            };
            let field = &mut header.as_old_mut().name;
            field[..full.len()].copy_from_slice(full.as_bytes());
            if let Some(link) = link {
                header.as_old_mut().linkname[..link.len()].copy_from_slice(link.as_bytes());
            }
            header.set_entry_type(kind);
            header.set_mode(mode);
            header.set_size(data.len() as u64);
            header.set_cksum();
            builder.append(&header, data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn zipfile(entries: &[Entry<'_>]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for entry in entries {
            match *entry {
                Entry::File(name, data) | Entry::Raw(name, data) | Entry::Script(name, data) => {
                    writer.start_file(name, options).unwrap();
                    writer.write_all(data).unwrap();
                }
                Entry::Symlink(name, target) | Entry::HardLink(name, target) => {
                    writer.add_symlink(name, target, options).unwrap();
                }
            }
        }
        writer.finish().unwrap().into_inner()
    }

    fn skill_md(name: &str, extra: &str) -> Vec<u8> {
        format!("---\nname: {name}\ndescription: Does {name} things.\n{extra}---\n\n# {name}\n")
            .into_bytes()
    }

    fn github_repo(sites: &FakeSites, archive: Vec<u8>) {
        sites.answer(
            "/gh/repos/acme/skills",
            "application/json",
            r#"{"default_branch":"main"}"#,
        );
        sites.answer("/gh/repos/acme/skills/commits/main", "text/plain", SHA);
        sites.answer(
            &format!("/codeload/acme/skills/tar.gz/{SHA}"),
            "application/x-gzip",
            archive,
        );
    }

    fn found<'a>(inspection: &'a Inspection, path: &str) -> &'a InstallCandidate {
        inspection
            .candidates
            .iter()
            .find(|candidate| candidate.path == path)
            .unwrap_or_else(|| panic!("{path} in {:#?}", inspection.candidates))
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn skills_install_from_github_lists_what_it_holds_and_installs_the_chosen() {
        let (sites, endpoints) = fake_sites().await;
        let pdf = skill_md("pdf", "license: MIT\n");
        let locked = skill_md("locked", "license: All rights reserved\n");
        let notes = skill_md("notes", "");
        github_repo(
            &sites,
            tarball(
                "skills-0123456",
                &[
                    Entry::File("README.md", b"# Skills"),
                    Entry::File("LICENSE", MIT.as_bytes()),
                    Entry::File("skills/pdf/SKILL.md", &pdf),
                    Entry::Script("skills/pdf/scripts/fill.js", b"console.log(1)"),
                    Entry::Symlink("skills/pdf/passwords", "/etc/passwd"),
                    Entry::HardLink("skills/pdf/hard", "skills-0123456/README.md"),
                    Entry::File("skills/pdf/node_modules/left/index.js", b"left behind"),
                    Entry::File("skills/locked/SKILL.md", &locked),
                    Entry::File("skills/notes/SKILL.md", &notes),
                    Entry::File("node_modules/dep/SKILL.md", &skill_md("dep", "")),
                ],
            ),
        );
        let state = Scratch::new("state");
        let store = SkillsStore::with_limits(state.path(), small_limits());
        let market = Marketplace::new(endpoints);

        let inspection = market
            .inspect(&store, "acme/skills", None)
            .await
            .expect("inspect");
        assert_eq!(inspection.source, "github");
        assert_eq!(inspection.title, "acme/skills");
        assert_eq!(inspection.commit.as_deref(), Some(SHA));
        assert_eq!(
            inspection.candidates.len(),
            3,
            "{:#?}",
            inspection.candidates
        );
        assert!(inspection.notes.iter().any(|note| note.contains("2 links")));

        let pdf = found(&inspection, "skills/pdf");
        assert_eq!(pdf.files, ["SKILL.md", "scripts/fill.js"]);
        assert_eq!(pdf.runtimes, ["node"]);
        assert!(pdf.has_scripts && !pdf.restricted && pdf.reason.is_none() && !pdf.conflict);
        let locked = found(&inspection, "skills/locked");
        assert!(locked.restricted && locked.reason.is_some());
        let notes = found(&inspection, "skills/notes");
        assert_eq!(
            notes.license.id.as_deref(),
            Some("MIT"),
            "the repository's license covers a skill without one"
        );

        let refused = market.install(
            &store,
            &inspection.token,
            &["skills/locked".to_owned()],
            false,
        );
        assert!(matches!(refused, Err(SkillsError::Refused(_))));

        let installed = market
            .install(&store, &inspection.token, &["skills/pdf".to_owned()], false)
            .expect("install");
        assert_eq!(installed.len(), 1);
        let record = &installed[0];
        assert_eq!(record.origin.source.as_deref(), Some("github"));
        assert_eq!(record.origin.reference.as_deref(), Some("acme/skills"));
        assert_eq!(record.origin.commit.as_deref(), Some(SHA));
        assert_eq!(record.origin.source_path.as_deref(), Some("skills/pdf"));
        assert!(
            record
                .origin
                .url
                .as_deref()
                .unwrap()
                .ends_with(&format!("/web/acme/skills/tree/{SHA}/skills/pdf"))
        );
        let folder = store.folder().join("pdf");
        assert!(folder.join("scripts/fill.js").is_file());
        assert!(fs::symlink_metadata(folder.join("passwords")).is_err());
        assert!(fs::symlink_metadata(folder.join("hard")).is_err());
        assert!(!folder.join("node_modules").exists());
        assert!(
            market
                .install(
                    &store,
                    &inspection.token,
                    &["skills/notes".to_owned()],
                    false
                )
                .is_err(),
            "an install uses its look once"
        );

        let again = market
            .inspect(&store, "github.com/acme/skills/tree/main/skills/pdf", None)
            .await
            .expect("inspect");
        assert_eq!(again.candidates.len(), 1);
        assert!(found(&again, "skills/pdf").conflict);
        let paths = ["skills/pdf".to_owned()];
        assert!(matches!(
            market.install(&store, &again.token, &paths, false),
            Err(SkillsError::Conflict(_))
        ));
        market
            .install(&store, &again.token, &paths, true)
            .expect("replace");
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn skills_install_refuses_downloads_that_reach_outside_their_folder() {
        let (sites, endpoints) = fake_sites().await;
        let state = Scratch::new("state");
        let store = SkillsStore::with_limits(state.path(), small_limits());
        let market = Marketplace::new(endpoints);
        let pdf = skill_md("pdf", "");
        for escape in [
            "skills-0123456/skills/pdf/../../../../escaped",
            "/tmp/loomwatch-escaped",
            "skills-0123456/skills/pdf/..\\..\\escaped",
        ] {
            github_repo(
                &sites,
                tarball(
                    "skills-0123456",
                    &[
                        Entry::File("skills/pdf/SKILL.md", &pdf),
                        Entry::Raw(escape, b"escaped"),
                    ],
                ),
            );
            let refused = market.inspect(&store, "acme/skills", None).await;
            assert!(
                matches!(&refused, Err(SkillsError::Refused(message)) if message.contains("outside")),
                "{escape}: {refused:?}"
            );
        }
        assert!(!state.path().join("escaped").exists());
        assert!(!Path::new("/tmp/loomwatch-escaped").exists());
        assert!(
            fs::read_dir(store.staging()).map_or(true, |mut entries| entries.next().is_none()),
            "a refused download leaves nothing staged"
        );

        sites.answer("/ch/api/v1/skills/evil/scan", "application/json", "{}");
        sites.answer(
            "/ch/api/v1/download",
            "application/zip",
            zipfile(&[
                Entry::File("SKILL.md", &pdf),
                Entry::Raw("../evil.txt", b"x"),
            ]),
        );
        let refused = market
            .inspect(&store, "acme/evil", Some(Source::ClawHub))
            .await;
        assert!(
            matches!(refused, Err(SkillsError::Refused(_))),
            "{refused:?}"
        );
    }

    #[tokio::test]
    async fn skills_install_caps_downloads_and_skills() {
        let (sites, endpoints) = fake_sites().await;
        let state = Scratch::new("state");
        let limits = small_limits();
        let store = SkillsStore::with_limits(state.path(), limits);
        let market = Marketplace::new(endpoints);
        let pdf = skill_md("pdf", "");
        let many = (0..10)
            .map(|index| format!("skills/many/part-{index}.md"))
            .collect::<Vec<_>>();
        let mut entries = vec![
            Entry::File("skills/pdf/SKILL.md", &pdf),
            Entry::File("skills/many/SKILL.md", b"---\nname: many\n---\n"),
        ];
        entries.extend(many.iter().map(|name| Entry::File(name, b"part")));
        github_repo(&sites, tarball("skills-0123456", &entries));
        let inspection = market
            .inspect(&store, "acme/skills", None)
            .await
            .expect("inspect");
        let many = found(&inspection, "skills/many");
        assert!(
            many.reason
                .as_deref()
                .unwrap()
                .contains("bigger than LoomWatch takes")
        );
        assert!(many.files.is_empty(), "a skill too big isn't unpacked");
        assert!(matches!(
            market.install(
                &store,
                &inspection.token,
                &["skills/many".to_owned()],
                false
            ),
            Err(SkillsError::Refused(_))
        ));

        // Random bytes don't compress, so the download itself passes the cap.
        let mut state = 0x9E37_79B9_7F4A_7C15_u64;
        let noise = (0..limits.download_bytes + 1024)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state.to_le_bytes()[0]
            })
            .collect::<Vec<_>>();
        github_repo(
            &sites,
            tarball(
                "skills-0123456",
                &[
                    Entry::File("skills/pdf/SKILL.md", &pdf),
                    Entry::File("skills/pdf/big.bin", &noise),
                ],
            ),
        );
        let refused = market.inspect(&store, "acme/skills", None).await;
        assert!(
            matches!(&refused, Err(SkillsError::Refused(message)) if message.contains("download is bigger")),
            "{refused:?}"
        );
    }

    #[tokio::test]
    async fn skills_install_from_clawhub_shows_its_scan_and_installs_the_zip() {
        let (sites, endpoints) = fake_sites().await;
        let state = Scratch::new("state");
        let store = SkillsStore::with_limits(state.path(), small_limits());
        let market = Marketplace::new(endpoints.clone());
        sites.answer(
            "/ch/api/v1/search",
            "application/json",
            serde_json::json!({"results": [
                {"displayName": "Pdf", "summary": "PDF tools.", "downloads": 50, "id": "clawhub:k1",
                 "canonicalUrl": "/acme/skills/pdf", "trust": {"installability": "installable"},
                 "install": {"kind": "clawhub", "reference": "acme/pdf", "sourceUrl": null}},
                {"displayName": "react-pdf", "id": "skills-sh:x",
                 "install": {"kind": "skills-sh", "reference": "skills-sh:acme/skills/react-pdf",
                             "sourceUrl": "https://www.skills.sh/acme/skills/react-pdf"}},
                {"displayName": "Unknown kind", "install": {"kind": "npm", "reference": "x"}},
                {"displayName": "Blocked", "trust": {"installability": "blocked"},
                 "install": {"kind": "clawhub", "reference": "acme/blocked"}}
            ]})
            .to_string(),
        );
        let results = market.search("pdf", Source::ClawHub).await.expect("search");
        assert_eq!(results.len(), 2, "{results:#?}");
        assert_eq!(results[0].source, "clawhub");
        assert_eq!(results[0].reference, "acme/pdf");
        assert_eq!(
            results[0].url,
            format!("{}/acme/skills/pdf", endpoints.clawhub)
        );
        assert_eq!(results[0].installs, Some(50));
        assert_eq!(results[1].source, "skills.sh");
        assert_eq!(results[1].reference, "acme/skills/react-pdf");

        sites.answer(
            "/ch/api/v1/skills/pdf/scan",
            "application/json",
            r#"{"moderation":null,"security":{"status":"clean","hasWarnings":true}}"#,
        );
        sites.answer(
            "/ch/api/v1/download",
            "application/zip",
            zipfile(&[
                Entry::File("SKILL.md", &skill_md("pdf", "")),
                Entry::File("_meta.json", b"{}"),
                Entry::Script("run.py", b"print(1)"),
                Entry::Symlink("secrets", "/etc/passwd"),
            ]),
        );
        let inspection = market
            .inspect(&store, "acme/pdf", Some(Source::ClawHub))
            .await
            .expect("inspect");
        let scan = inspection.scan.as_ref().expect("scan");
        assert_eq!(scan.status, "clean");
        assert!(scan.has_warnings);
        assert!(sites.requests().iter().any(|request| request.contains("slug=pdf") && request.contains("ownerHandle=acme")));
        let pdf = found(&inspection, ".");
        assert_eq!(pdf.files, ["SKILL.md", "_meta.json", "run.py"]);
        assert_eq!(pdf.runtimes, ["python"]);
        let installed = market
            .install(&store, &inspection.token, &[".".to_owned()], false)
            .expect("install");
        assert_eq!(installed[0].origin.source.as_deref(), Some("clawhub"));
        assert_eq!(installed[0].origin.reference.as_deref(), Some("acme/pdf"));
        assert!(store.folder().join("pdf/run.py").is_file());
        assert!(fs::symlink_metadata(store.folder().join("pdf/secrets")).is_err());

        // Either one alone stops the install: ClawHub's moderators blocking it, or its scan.
        for scan in [
            r#"{"moderation":{"isMalwareBlocked":true},"security":{"status":"clean"}}"#,
            r#"{"moderation":null,"security":{"status":"malicious"}}"#,
        ] {
            sites.answer("/ch/api/v1/skills/bad/scan", "application/json", scan);
            let refused = market
                .inspect(&store, "acme/bad", Some(Source::ClawHub))
                .await;
            assert!(
                matches!(&refused, Err(SkillsError::Refused(message)) if message.contains("harmful")),
                "{scan}: {refused:?}"
            );
        }
    }

    #[tokio::test]
    async fn skills_install_follows_clawhub_github_handoffs_and_skills_sh_names() {
        let (sites, endpoints) = fake_sites().await;
        let state = Scratch::new("state");
        let store = SkillsStore::with_limits(state.path(), small_limits());
        let market = Marketplace::new(endpoints);
        github_repo(
            &sites,
            tarball(
                "skills-0123456",
                &[
                    Entry::File("skills/pdf/SKILL.md", &skill_md("pdf", "")),
                    Entry::File("skills/docx/SKILL.md", &skill_md("docx", "")),
                    Entry::File("other/x/SKILL.md", &skill_md("react-pdf", "")),
                ],
            ),
        );
        sites.answer(
            "/ch/api/v1/download",
            "application/json",
            serde_json::json!({"sourceRef": "public-github", "repo": "acme/skills", "commit": SHA,
                "path": "skills/docx", "contentHash": "x", "archiveUrl": "https://elsewhere.example/a.tgz"})
            .to_string(),
        );
        let inspection = market
            .inspect(&store, "https://clawhub.ai/acme/skills/docx", None)
            .await
            .expect("inspect");
        assert_eq!(inspection.source, "clawhub");
        assert_eq!(
            inspection
                .candidates
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            ["docx"]
        );
        assert!(
            sites
                .requests()
                .iter()
                .all(|request| !request.contains("elsewhere")),
            "the archive address in a handoff is never followed"
        );

        sites.answer(
            "/ss/api/search",
            "application/json",
            r#"{"skills":[{"id":"acme/skills/react-pdf","source":"acme/skills","skillId":"react-pdf","name":"react-pdf","installs":7},{"id":"bad id","source":"x","skillId":"y","name":"y"}]}"#,
        );
        let results = market
            .search("pdf", Source::SkillsSh)
            .await
            .expect("search");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].installs, Some(7));
        let inspection = market
            .inspect(&store, &results[0].reference, Some(Source::SkillsSh))
            .await
            .expect("inspect");
        assert_eq!(inspection.source, "skills.sh");
        assert_eq!(
            inspection
                .candidates
                .iter()
                .map(|c| c.path.as_str())
                .collect::<Vec<_>>(),
            ["other/x"],
            "the skill whose SKILL.md is named react-pdf, wherever it sits"
        );
        let installed = market
            .install(&store, &inspection.token, &["other/x".to_owned()], false)
            .expect("install");
        assert_eq!(installed[0].origin.source.as_deref(), Some("skills.sh"));
        assert_eq!(
            installed[0].origin.reference.as_deref(),
            Some("acme/skills/react-pdf")
        );
    }

    #[test]
    fn skills_install_reads_links_and_names() {
        let github = |text| match parse_target(text, None) {
            Ok(Target::GitHub(repo)) => (repo.owner, repo.repo, repo.path, repo.reference),
            other => panic!("{text}: {other:?}"),
        };
        assert_eq!(
            github("acme/skills"),
            ("acme".into(), "skills".into(), None, None)
        );
        assert_eq!(
            github("acme/skills/skills/pdf@v1.2"),
            (
                "acme".into(),
                "skills".into(),
                Some("skills/pdf".into()),
                Some("v1.2".into())
            )
        );
        assert_eq!(
            github("https://github.com/acme/skills.git"),
            ("acme".into(), "skills".into(), None, None)
        );
        assert_eq!(
            github("github.com/acme/skills/blob/main/skills/pdf/SKILL.md"),
            (
                "acme".into(),
                "skills".into(),
                Some("skills/pdf".into()),
                Some("main".into())
            )
        );
        assert!(matches!(
            parse_target("https://www.skills.sh/acme/skills/pdf", None),
            Ok(Target::SkillsSh { skill, .. }) if skill == "pdf"
        ));
        assert!(matches!(
            parse_target("skills-sh:acme/skills/pdf", Some(Source::SkillsSh)),
            Ok(Target::SkillsSh { .. })
        ));
        assert!(matches!(
            parse_target("acme/pdf", Some(Source::ClawHub)),
            Ok(Target::ClawHub { owner, slug }) if owner == "acme" && slug == "pdf"
        ));
        for bad in [
            "",
            "acme",
            "acme/../etc",
            "acme/skills@../../x",
            "acme/skills@-x",
            "https://gitlab.com/acme/skills",
            "ftp://github.com/acme/skills",
            "acme/.hidden",
        ] {
            assert!(parse_target(bad, None).is_err(), "{bad}");
        }
        assert_eq!(
            clean_entry_path("a/./b//c").unwrap().as_deref(),
            Some("a/b/c")
        );
        assert!(clean_entry_path("a/../b").is_err());
        assert!(clean_entry_path("C:/x").is_err());
    }
}
