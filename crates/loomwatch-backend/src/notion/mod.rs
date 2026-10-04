//! User-owned Notion connections. Secrets live in the OS credential store only.
//!
//! There are two ways in. Notion sign-in ([`sign_in`]) is the default: the operator allows
//! `LoomWatch` on Notion's own page, and every call then goes through Notion's hosted MCP server
//! ([`mcp`]). An integration token pasted under Advanced reaches the REST API instead, for
//! workspaces whose admins only allow approved AI apps. [`Publisher`] is the delivery side either
//! way: it turns a reply's Markdown into a child page of the connected destination (see
//! `docs/decisions/0010-routines-and-notion-delivery.md` and `0049-sign-in-to-notion.md`).
mod mcp;
mod sign_in;

use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, uri::Authority},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

#[cfg(target_os = "macos")]
const SERVICE: &str = "LoomWatch.Notion";
#[cfg(target_os = "macos")]
const ACCOUNT: &str = "local-workspace";
const VERSION: &str = "2026-03-11";
/// Upstream bodies larger than this are refused, including ones without `Content-Length`.
const MAX_RESPONSE_BYTES: usize = 2_000_000;

/// Every read-modify-write of the stored connection holds this, in the router and in
/// [`Publisher`] alike. Notion retires a refresh token as it answers with the next one, so two
/// tasks renewing the same stored grant would leave one of them holding a retired token.
static WRITES: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Notion's addresses. Tests point them at a local stand-in.
#[derive(Clone)]
struct Endpoints {
    /// The REST API, for integration tokens.
    api: String,
    /// Notion's hosted MCP server, which is also the `resource` a sign-in asks access to.
    mcp: String,
    authorize: String,
    token: String,
    register: String,
    revoke: String,
}

impl Endpoints {
    /// The addresses Notion publishes in its authorization server metadata
    /// (`https://mcp.notion.com/.well-known/oauth-authorization-server`).
    fn notion() -> Self {
        Self {
            api: "https://api.notion.com/v1".into(),
            mcp: "https://mcp.notion.com/mcp".into(),
            authorize: "https://mcp.notion.com/authorize".into(),
            token: "https://mcp.notion.com/token".into(),
            register: "https://mcp.notion.com/register".into(),
            revoke: "https://mcp.notion.com/token".into(),
        }
    }
}

/// Where the connection is kept: the macOS Keychain, or memory in tests.
#[derive(Clone)]
enum Store {
    Keychain,
    #[cfg(test)]
    Memory(Arc<std::sync::Mutex<Option<String>>>),
}

impl Store {
    /// Whether a connection can be kept here at all. Linux and Windows have no store yet.
    fn available(&self) -> bool {
        match self {
            Self::Keychain => cfg!(target_os = "macos"),
            #[cfg(test)]
            Self::Memory(_) => true,
        }
    }

    async fn load(&self) -> ApiResult<Option<Connection>> {
        let stored = match self {
            Self::Keychain => keychain_read().await?,
            #[cfg(test)]
            Self::Memory(slot) => slot.lock().map_err(|_| storage_error())?.clone(),
        };
        stored
            .map(|value| serde_json::from_str(&value).map_err(|_| storage_error()))
            .transpose()
    }

    async fn save(&self, connection: Option<&Connection>) -> ApiResult<()> {
        let value = connection
            .map(|connection| serde_json::to_string(connection).map_err(|_| storage_error()))
            .transpose()?;
        match self {
            Self::Keychain => keychain_write(value).await,
            #[cfg(test)]
            Self::Memory(slot) => {
                *slot.lock().map_err(|_| storage_error())? = value;
                Ok(())
            }
        }
    }
}

#[derive(Clone)]
struct NotionState {
    client: Client,
    gate: Arc<Mutex<()>>,
    store: Store,
    endpoints: Arc<Endpoints>,
    /// The sign-in the operator started and Notion has not sent back yet.
    pending: Arc<Mutex<Option<sign_in::Pending>>>,
}

impl NotionState {
    /// A session with Notion's MCP server for the stored sign-in.
    async fn session(&self) -> ApiResult<mcp::Session<'_>> {
        let bearer = sign_in::bearer(&self.client, &self.endpoints, &self.store).await?;
        mcp::Session::open(&self.client, &self.endpoints.mcp, bearer).await
    }
}

// Deliberately no Debug implementation: these structures contain credentials.
#[derive(Clone, Serialize, Deserialize)]
struct Connection {
    #[serde(flatten)]
    access: Access,
    name: String,
    #[serde(default)]
    destination: Option<Page>,
}

/// How `LoomWatch` reaches the workspace. A pasted integration token keeps the JSON it was always
/// stored as (`{"token": …}`); a Notion sign-in is stored as `{"signIn": …}`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum Access {
    SignIn {
        #[serde(rename = "signIn")]
        sign_in: sign_in::Grant,
    },
    Token {
        token: String,
    },
}

#[derive(Clone, Serialize, Deserialize)]
struct Page {
    id: String,
    title: String,
}

/// The caller must only mount this router on a loopback listener.
///
/// # Errors
/// Returns an error if the HTTPS client cannot be initialized.
pub fn router() -> anyhow::Result<Router> {
    Ok(router_with(NotionState {
        client: build_client()?,
        gate: Arc::new(Mutex::new(())),
        store: Store::Keychain,
        endpoints: Arc::new(Endpoints::notion()),
        pending: Arc::new(Mutex::new(None)),
    }))
}

fn router_with(state: NotionState) -> Router {
    let managed = Router::new()
        .route(
            "/api/notion/connection",
            get(status).post(connect).delete(disconnect),
        )
        .route("/api/notion/sign-in", post(sign_in::start))
        .route("/api/notion/pages", post(pages))
        .route("/api/notion/destination", put(destination))
        .layer(DefaultBodyLimit::max(8192))
        .route_layer(middleware::from_fn(protect))
        .route_layer(middleware::from_fn(crate::watch_api::local_evidence))
        .with_state(state.clone());
    // Notion sends the browser back here from its own site, so this one route cannot ask for a
    // same-origin request. The one-time state it has to echo is what proves the visit.
    let callback = Router::new()
        .route(sign_in::CALLBACK, get(sign_in::finish))
        .route_layer(middleware::from_fn(loopback_only))
        .with_state(state);
    managed.merge(callback)
}

/// The HTTPS client both the connection router and the publisher use: no redirects,
/// bounded connect and request times.
fn build_client() -> anyhow::Result<Client> {
    Ok(Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .build()?)
}

async fn protect(request: Request, next: Next) -> Response {
    if request.method() != axum::http::Method::GET
        && request
            .headers()
            .get("x-loomwatch-request")
            .is_none_or(|v| v != "1")
    {
        return failure(
            StatusCode::FORBIDDEN,
            "Open Connections in LoomWatch to manage Notion.",
        )
        .into_response();
    }
    next.run(request).await
}

/// The `Host` a request named, when it is this computer. A name that resolves here only by DNS
/// rebinding names another host, so it never reaches the sign-in routes.
fn loopback_host(headers: &HeaderMap) -> Option<&str> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    let authority = host.parse::<Authority>().ok()?;
    matches!(
        authority.host(),
        "localhost" | "127.0.0.1" | "[::1]" | "::1"
    )
    .then_some(host)
}

async fn loopback_only(request: Request, next: Next) -> Response {
    if loopback_host(request.headers()).is_none() {
        return failure(
            StatusCode::FORBIDDEN,
            "Open LoomWatch on this computer to connect Notion.",
        )
        .into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: &'static str,
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error": self.message}))).into_response()
    }
}
fn failure(status: StatusCode, message: &'static str) -> ApiError {
    ApiError { status, message }
}
type ApiResult<T> = Result<T, ApiError>;

fn unreachable() -> ApiError {
    failure(
        StatusCode::BAD_GATEWAY,
        "Could not reach Notion. Check your internet connection and retry.",
    )
}
fn unreadable() -> ApiError {
    failure(
        StatusCode::BAD_GATEWAY,
        "Notion returned an unreadable response. Retry.",
    )
}

/// The rest of `response`'s body, refused past `limit` bytes.
async fn read_bounded(response: &mut reqwest::Response, limit: usize) -> ApiResult<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        failure(
            StatusCode::BAD_GATEWAY,
            "Notion returned an incomplete response. Retry.",
        )
    })? {
        if bytes.len() + chunk.len() > limit {
            return Err(failure(
                StatusCode::BAD_GATEWAY,
                "Notion's response was too large. Use a more specific search.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(target_os = "macos")]
fn credential() -> ApiResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| storage_error())
}
fn storage_error() -> ApiError {
    failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "The secure credential store is unavailable. Unlock your macOS Keychain and retry. Nothing is saved in project files.",
    )
}

async fn keychain_read() -> ApiResult<Option<String>> {
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            match credential()?.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(storage_error()),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(storage_error())
        }
    })
    .await
    .map_err(|_| storage_error())?
}

async fn keychain_write(value: Option<String>) -> ApiResult<()> {
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let entry = credential()?;
            if let Some(value) = value {
                entry.set_password(&value).map_err(|_| storage_error())
            } else {
                match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(_) => Err(storage_error()),
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = value;
            Err(storage_error())
        }
    })
    .await
    .map_err(|_| storage_error())?
}

fn public_status(connection: Option<&Connection>) -> Value {
    connection.map_or_else(
        || json!({"connected": false}),
        |c| {
            let via = match c.access {
                Access::SignIn { .. } => "signIn",
                Access::Token { .. } => "token",
            };
            json!({"connected": true, "name": c.name, "destination": c.destination, "via": via})
        },
    )
}

async fn status(State(state): State<NotionState>) -> ApiResult<Json<Value>> {
    let _guard = state.gate.lock().await;
    Ok(Json(public_status(state.store.load().await?.as_ref())))
}

async fn request(
    client: &Client,
    api: &str,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> ApiResult<Value> {
    let mut request = client.request(method, format!("{api}/{path}"));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let mut response = request
        .bearer_auth(token)
        .header("Notion-Version", VERSION)
        .send()
        .await
        .map_err(|_| unreachable())?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 => failure(
                StatusCode::UNAUTHORIZED,
                "Notion rejected this token. Reconnect with a valid token.",
            ),
            403 | 404 => failure(
                StatusCode::FORBIDDEN,
                "Notion cannot access this page. Open the page in Notion, choose ••• → Connections, and add your integration.",
            ),
            429 => failure(
                StatusCode::TOO_MANY_REQUESTS,
                "Notion is rate limiting requests. Wait a minute and retry.",
            ),
            _ => failure(
                StatusCode::BAD_GATEWAY,
                "Notion could not complete the request. Retry shortly.",
            ),
        });
    }
    let bytes = read_bounded(&mut response, MAX_RESPONSE_BYTES).await?;
    serde_json::from_slice(&bytes).map_err(|_| unreadable())
}

#[derive(Deserialize)]
struct Connect {
    token: String,
}
/// `POST /api/notion/connection`: connect with an integration token, the Advanced way in.
async fn connect(
    State(state): State<NotionState>,
    Json(input): Json<Connect>,
) -> ApiResult<Json<Value>> {
    let token = input.token.trim();
    if !(20..=4096).contains(&token.len()) || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "Paste a complete Notion integration token.",
        ));
    }
    let _guard = state.gate.lock().await;
    let bot = request(
        &state.client,
        &state.endpoints.api,
        token,
        Method::GET,
        "users/me",
        None,
    )
    .await?;
    let name = bot
        .pointer("/bot/workspace_name")
        .or_else(|| bot.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("Notion workspace");
    let connection = Connection {
        access: Access::Token {
            token: token.to_owned(),
        },
        name: name.to_owned(),
        destination: None,
    };
    let status = public_status(Some(&connection));
    let _writes = WRITES.lock().await;
    state.store.save(Some(&connection)).await?;
    Ok(Json(status))
}

/// `DELETE /api/notion/connection`: forget the connection here, then ask Notion to forget a
/// sign-in too. That second step is best effort, so an offline Mac can still disconnect.
async fn disconnect(State(state): State<NotionState>) -> ApiResult<Json<Value>> {
    let _guard = state.gate.lock().await;
    let _writes = WRITES.lock().await;
    // An entry that no longer reads must still be removable.
    let previous = state.store.load().await.ok().flatten();
    state.store.save(None).await?;
    if let Some(Connection {
        access: Access::SignIn { sign_in },
        ..
    }) = previous
    {
        sign_in::revoke(&state.client, &state.endpoints, &sign_in).await;
    }
    Ok(Json(public_status(None)))
}

async fn connected(store: &Store) -> ApiResult<Connection> {
    store
        .load()
        .await?
        .ok_or_else(|| failure(StatusCode::CONFLICT, "Connect your Notion workspace first."))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Search {
    #[serde(default)]
    query: String,
    cursor: Option<String>,
}
async fn pages(
    State(state): State<NotionState>,
    Json(input): Json<Search>,
) -> ApiResult<Json<Value>> {
    if input.query.len() > 200 || input.cursor.as_ref().is_some_and(|c| c.len() > 200) {
        return Err(failure(StatusCode::BAD_REQUEST, "Search text is too long."));
    }
    let _guard = state.gate.lock().await;
    let token = match connected(&state.store).await?.access {
        Access::Token { token } => token,
        Access::SignIn { .. } => {
            // Notion's search tool has no cursor: one answer holds every page it will show.
            let pages = mcp::search(&mut state.session().await?, input.query.trim()).await?;
            return Ok(Json(json!({"pages": pages, "nextCursor": null})));
        }
    };
    let mut body = json!({"query": input.query, "filter": {"value": "page", "property": "object"}, "page_size": 50});
    if let Some(cursor) = input.cursor {
        body["start_cursor"] = json!(cursor);
    }
    let result = request(
        &state.client,
        &state.endpoints.api,
        &token,
        Method::POST,
        "search",
        Some(body),
    )
    .await?;
    let pages: Vec<Page> = result
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(page)
        .collect();
    Ok(Json(
        json!({"pages": pages, "nextCursor": result.get("next_cursor")}),
    ))
}
fn page(value: &Value) -> Option<Page> {
    if value.get("archived") == Some(&json!(true)) || value.get("in_trash") == Some(&json!(true)) {
        return None;
    }
    let id = uuid::Uuid::parse_str(value.get("id")?.as_str()?)
        .ok()?
        .to_string();
    let title: String = value
        .get("properties")?
        .as_object()?
        .values()
        .filter_map(|v| v.get("title").and_then(Value::as_array))
        .flatten()
        .filter_map(|v| {
            v.get("plain_text")
                .or_else(|| v.pointer("/text/content"))
                .and_then(Value::as_str)
        })
        .collect();
    Some(Page {
        id,
        title: if title.is_empty() {
            "Untitled page".into()
        } else {
            title
        },
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Destination {
    page_id: String,
}
async fn destination(
    State(state): State<NotionState>,
    Json(input): Json<Destination>,
) -> ApiResult<Json<Value>> {
    let id = uuid::Uuid::parse_str(&input.page_id).map_err(|_| {
        failure(
            StatusCode::BAD_REQUEST,
            "Choose a page from the search results.",
        )
    })?;
    let _guard = state.gate.lock().await;
    let chosen = match connected(&state.store).await?.access {
        Access::Token { token } => page(
            &request(
                &state.client,
                &state.endpoints.api,
                &token,
                Method::GET,
                &format!("pages/{id}"),
                None,
            )
            .await?,
        ),
        Access::SignIn { .. } => mcp::page(&mut state.session().await?, &id.to_string()).await?,
    }
    .ok_or_else(|| {
        failure(
            StatusCode::BAD_REQUEST,
            "This page is unavailable. Choose another page.",
        )
    })?;
    let _writes = WRITES.lock().await;
    // Read again: renewing the sign-in may have rotated its grant since the read above.
    let mut connection = connected(&state.store).await?;
    connection.destination = Some(chosen);
    let status = public_status(Some(&connection));
    state.store.save(Some(&connection)).await?;
    Ok(Json(status))
}

// ---------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------

/// What the delivery reports when no workspace or destination page is connected.
pub(crate) const NOT_CONNECTED_MESSAGE: &str =
    "Notion is not connected. Open Connections and choose a destination page.";
/// Notion accepts at most this many children per create or append request.
const BLOCKS_PER_REQUEST: usize = 100;
/// Notion rejects a `rich_text` item whose content exceeds this many characters.
const MAX_RICH_TEXT_CHARS: usize = 2000;
/// Upper bound on the blocks one delivery writes; the rest is replaced by a marker.
const MAX_BLOCKS: usize = 500;
const TRUNCATED_MARKER: &str = "… truncated";

/// A page the publisher created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Published {
    pub(crate) page_id: String,
    pub(crate) url: String,
}

/// Why a delivery did not create a page. Every variant carries operator-facing text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PublishError {
    /// The destination already has a child page with exactly this title.
    Duplicate { page_id: String, url: String },
    /// Nothing was written; the message says why in the same words Connections uses.
    Failed(String),
}

impl From<ApiError> for PublishError {
    fn from(error: ApiError) -> Self {
        Self::Failed(error.message.to_owned())
    }
}

/// Publishes Markdown as a child page of the operator's chosen destination.
pub(crate) struct Publisher {
    client: Client,
    store: Store,
    endpoints: Arc<Endpoints>,
}

impl Publisher {
    /// A publisher reading the stored connection, with its own HTTPS client.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTPS client cannot be initialized.
    pub(crate) fn new() -> anyhow::Result<Self> {
        Ok(Self {
            client: build_client()?,
            store: Store::Keychain,
            endpoints: Arc::new(Endpoints::notion()),
        })
    }

    /// A publisher that is never connected, for tests that must not reach the keychain.
    #[cfg(test)]
    pub(crate) fn disconnected() -> Self {
        Self::with(Store::Memory(Arc::default()), Endpoints::notion())
    }

    #[cfg(test)]
    fn with(store: Store, endpoints: Endpoints) -> Self {
        Self {
            client: build_client().expect("HTTPS client"),
            store,
            endpoints: Arc::new(endpoints),
        }
    }

    /// Create `title` under the connected destination holding `markdown`, unless a child
    /// page with that exact title already exists.
    ///
    /// # Errors
    ///
    /// [`PublishError::Duplicate`] when the guard finds an existing page;
    /// [`PublishError::Failed`] when nothing is connected or Notion refuses a request.
    pub(crate) async fn publish(
        &self,
        title: &str,
        markdown: &str,
    ) -> Result<Published, PublishError> {
        let connection = self.store.load().await?;
        self.publish_with(connection, title, markdown).await
    }

    async fn publish_with(
        &self,
        connection: Option<Connection>,
        title: &str,
        markdown: &str,
    ) -> Result<Published, PublishError> {
        let Some(Connection {
            access,
            destination: Some(destination),
            ..
        }) = connection
        else {
            return Err(PublishError::Failed(NOT_CONNECTED_MESSAGE.to_owned()));
        };
        match access {
            Access::Token { token } => {
                self.publish_with_token(&token, &destination, title, markdown)
                    .await
            }
            Access::SignIn { .. } => {
                let bearer = sign_in::bearer(&self.client, &self.endpoints, &self.store).await?;
                let mut session =
                    mcp::Session::open(&self.client, &self.endpoints.mcp, bearer).await?;
                mcp::publish(&mut session, &destination, title, markdown).await
            }
        }
    }

    async fn publish_with_token(
        &self,
        token: &str,
        destination: &Page,
        title: &str,
        markdown: &str,
    ) -> Result<Published, PublishError> {
        if let Some((page_id, url)) = self.existing_child(token, &destination.id, title).await? {
            return Err(PublishError::Duplicate { page_id, url });
        }
        let blocks = markdown_blocks(markdown);
        let mut chunks = blocks.chunks(BLOCKS_PER_REQUEST);
        let first = chunks.next().map(<[Value]>::to_vec).unwrap_or_default();
        let created = request(
            &self.client,
            &self.endpoints.api,
            token,
            Method::POST,
            "pages",
            Some(json!({
                "parent": {"page_id": destination.id},
                "properties": {"title": {"title": [text_item(title)]}},
                "children": first,
            })),
        )
        .await?;
        let page_id = created
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                PublishError::Failed("Notion created the page but returned no id.".to_owned())
            })?
            .to_owned();
        let url = created
            .get("url")
            .and_then(Value::as_str)
            .map_or_else(|| page_url(&page_id), str::to_owned);
        for chunk in chunks {
            request(
                &self.client,
                &self.endpoints.api,
                token,
                Method::PATCH,
                &format!("blocks/{page_id}/children"),
                Some(json!({"children": chunk})),
            )
            .await?;
        }
        Ok(Published { page_id, url })
    }

    /// The id and URL of a `child_page` of `parent` titled exactly `title`, following
    /// pagination to the end.
    async fn existing_child(
        &self,
        token: &str,
        parent: &str,
        title: &str,
    ) -> Result<Option<(String, String)>, PublishError> {
        let mut cursor: Option<String> = None;
        loop {
            let mut path = format!("blocks/{parent}/children?page_size=100");
            if let Some(cursor) = &cursor {
                path.push_str("&start_cursor=");
                path.push_str(cursor);
            }
            let page = request(
                &self.client,
                &self.endpoints.api,
                token,
                Method::GET,
                &path,
                None,
            )
            .await?;
            let found = page
                .get("results")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("child_page"))
                .find(|block| {
                    block.pointer("/child_page/title").and_then(Value::as_str) == Some(title)
                })
                .and_then(|block| block.get("id").and_then(Value::as_str))
                .map(|id| (id.to_owned(), page_url(id)));
            if found.is_some() {
                return Ok(found);
            }
            cursor = page
                .get("next_cursor")
                .and_then(Value::as_str)
                .filter(|next| {
                    !next.is_empty()
                        && next
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                })
                .map(str::to_owned);
            if cursor.is_none() {
                return Ok(None);
            }
        }
    }
}

/// The public page URL Notion derives from an id, for responses that carry none.
fn page_url(id: &str) -> String {
    format!("https://www.notion.so/{}", id.replace('-', ""))
}

fn text_item(content: &str) -> Value {
    json!({"type": "text", "text": {"content": content}})
}

/// Translate Markdown into Notion block objects: `#`/`##`/`###` headings, `-`/`*` bullets,
/// `1.` numbered items, `>` quotes, `---` dividers, fenced code, and blank-line-separated
/// paragraphs, with `[text](url)`, `**bold**`, `*italic*`/`_italic_` and `` `code` ``
/// inline. Rich-text items are split at Notion's 2000-character limit and the block count
/// is capped at 500 (the last block then reads "… truncated").
pub(crate) fn markdown_blocks(markdown: &str) -> Vec<Value> {
    let mut blocks = Vec::new();
    let mut paragraph: Vec<&str> = Vec::new();
    let mut fence: Option<Vec<&str>> = None;
    for line in markdown.lines() {
        if let Some(code) = fence.as_mut() {
            if line.trim_start().starts_with("```") {
                blocks.push(code_block(&code.join("\n")));
                fence = None;
            } else {
                code.push(line);
            }
            continue;
        }
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            flush_paragraph(&mut paragraph, &mut blocks);
            fence = Some(Vec::new());
        } else if trimmed.is_empty() {
            flush_paragraph(&mut paragraph, &mut blocks);
        } else if let Some(block) = line_block(trimmed) {
            flush_paragraph(&mut paragraph, &mut blocks);
            blocks.push(block);
        } else {
            paragraph.push(trimmed);
        }
    }
    if let Some(code) = fence {
        blocks.push(code_block(&code.join("\n")));
    }
    flush_paragraph(&mut paragraph, &mut blocks);
    if blocks.len() > MAX_BLOCKS {
        blocks.truncate(MAX_BLOCKS - 1);
        blocks.push(rich_block("paragraph", TRUNCATED_MARKER));
    }
    blocks
}

fn flush_paragraph(paragraph: &mut Vec<&str>, blocks: &mut Vec<Value>) {
    if !paragraph.is_empty() {
        blocks.push(rich_block("paragraph", &paragraph.join("\n")));
        paragraph.clear();
    }
}

/// A block for a line that is not paragraph text, or `None` when it is.
fn line_block(line: &str) -> Option<Value> {
    if matches!(line, "---" | "***" | "___") {
        return Some(json!({"object": "block", "type": "divider", "divider": {}}));
    }
    for (prefix, kind) in [
        ("# ", "heading_1"),
        ("## ", "heading_2"),
        ("### ", "heading_3"),
        ("#### ", "heading_3"),
        ("##### ", "heading_3"),
        ("###### ", "heading_3"),
    ] {
        if let Some(text) = line.strip_prefix(prefix) {
            return Some(rich_block(kind, text.trim()));
        }
    }
    if let Some(text) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
        return Some(rich_block("bulleted_list_item", text.trim()));
    }
    if let Some(text) = numbered_item(line) {
        return Some(rich_block("numbered_list_item", text.trim()));
    }
    if let Some(text) = line.strip_prefix('>') {
        return Some(rich_block("quote", text.trim()));
    }
    None
}

/// The text after a `1. ` / `1) ` marker.
fn numbered_item(line: &str) -> Option<&str> {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let rest = &line[digits..];
    rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))
}

fn rich_block(kind: &str, text: &str) -> Value {
    json!({"object": "block", "type": kind, kind: {"rich_text": rich_text(text)}})
}

fn code_block(code: &str) -> Value {
    let items: Vec<Value> = split_long(code)
        .into_iter()
        .map(|chunk| text_item(&chunk))
        .collect();
    json!({"object": "block", "type": "code", "code": {"rich_text": items, "language": "plain text"}})
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Style {
    bold: bool,
    italic: bool,
    code: bool,
    link: Option<String>,
}

/// Inline Markdown → Notion rich-text items. Unmatched markers stay literal text.
fn rich_text(text: &str) -> Vec<Value> {
    let chars: Vec<char> = text.chars().collect();
    let mut spans: Vec<(String, Style)> = Vec::new();
    let mut plain = String::new();
    let mut index = 0;
    while index < chars.len() {
        if let Some((content, style, consumed)) = inline_span(&chars, index) {
            if !plain.is_empty() {
                spans.push((std::mem::take(&mut plain), Style::default()));
            }
            spans.push((content, style));
            index += consumed;
        } else {
            plain.push(chars[index]);
            index += 1;
        }
    }
    if !plain.is_empty() {
        spans.push((plain, Style::default()));
    }
    spans
        .into_iter()
        .flat_map(|(content, style)| {
            split_long(&content)
                .into_iter()
                .map(move |chunk| styled_item(&chunk, &style))
        })
        .collect()
}

/// A styled span starting at `at`: its text, style and how many chars it consumed.
fn inline_span(chars: &[char], at: usize) -> Option<(String, Style, usize)> {
    let rest = &chars[at..];
    let styled = |bold, italic, code| Style {
        bold,
        italic,
        code,
        link: None,
    };
    if rest[0] == '`' {
        let end = find(rest, 1, &['`'])?;
        let content: String = rest[1..end].iter().collect();
        return (!content.is_empty()).then(|| (content, styled(false, false, true), end + 1));
    }
    if rest[0] == '[' {
        let close = find(rest, 1, &[']', '('])?;
        let end = find(rest, close + 2, &[')'])?;
        let url: String = rest[close + 2..end].iter().collect();
        let content: String = rest[1..close].iter().collect();
        let linkable = ["http://", "https://", "mailto:"]
            .iter()
            .any(|scheme| url.starts_with(scheme));
        return (linkable && !content.is_empty()).then(|| {
            let style = Style {
                link: Some(url),
                ..Style::default()
            };
            (content, style, end + 1)
        });
    }
    if rest.starts_with(&['*', '*']) {
        let end = find(rest, 2, &['*', '*'])?;
        let content: String = rest[2..end].iter().collect();
        return (!content.trim().is_empty())
            .then(|| (content, styled(true, false, false), end + 2));
    }
    if rest[0] == '*' || rest[0] == '_' {
        let marker = rest[0];
        let word_boundary_before = marker == '*' || at == 0 || !chars[at - 1].is_alphanumeric();
        if !word_boundary_before || rest.get(1).is_none_or(|next| next.is_whitespace()) {
            return None;
        }
        let end = find(rest, 2, &[marker])?;
        let word_boundary_after =
            marker == '*' || rest.get(end + 1).is_none_or(|next| !next.is_alphanumeric());
        if rest[end - 1].is_whitespace() || !word_boundary_after {
            return None;
        }
        let content: String = rest[1..end].iter().collect();
        return Some((content, styled(false, true, false), end + 1));
    }
    None
}

/// Index of the first occurrence of `needle` in `haystack` at or after `from`.
fn find(haystack: &[char], from: usize, needle: &[char]) -> Option<usize> {
    (from..=haystack.len().checked_sub(needle.len())?)
        .find(|&index| haystack[index..index + needle.len()] == *needle)
}

/// Split `content` into pieces Notion accepts as one rich-text item.
fn split_long(content: &str) -> Vec<String> {
    let chars: Vec<char> = content.chars().collect();
    if chars.len() <= MAX_RICH_TEXT_CHARS {
        return vec![content.to_owned()];
    }
    chars
        .chunks(MAX_RICH_TEXT_CHARS)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

fn styled_item(content: &str, style: &Style) -> Value {
    let mut item = text_item(content);
    if let Some(url) = &style.link {
        item["text"]["link"] = json!({"url": url});
    }
    let mut annotations = serde_json::Map::new();
    for (name, on) in [
        ("bold", style.bold),
        ("italic", style.italic),
        ("code", style.code),
    ] {
        if on {
            annotations.insert(name.to_owned(), Value::Bool(true));
        }
    }
    if !annotations.is_empty() {
        item["annotations"] = Value::Object(annotations);
    }
    item
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, header},
    };
    use std::fmt::Write as _;
    use tower::ServiceExt;

    fn kinds(blocks: &[Value]) -> Vec<&str> {
        blocks
            .iter()
            .map(|block| block["type"].as_str().unwrap())
            .collect()
    }

    fn plain(block: &Value) -> String {
        let kind = block["type"].as_str().unwrap();
        block[kind]["rich_text"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["text"]["content"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn markdown_blocks_map_structure_to_notion_block_types() {
        let blocks = markdown_blocks(
            "# Title\n\nFirst line\nsecond line\n\n## Section\n### Sub\n#### Deeper\n- one\n* two\n1. first\n2) second\n> quoted\n---\nlast paragraph\n",
        );
        assert_eq!(
            kinds(&blocks),
            [
                "heading_1",
                "paragraph",
                "heading_2",
                "heading_3",
                "heading_3",
                "bulleted_list_item",
                "bulleted_list_item",
                "numbered_list_item",
                "numbered_list_item",
                "quote",
                "divider",
                "paragraph",
            ]
        );
        assert_eq!(plain(&blocks[0]), "Title");
        assert_eq!(
            plain(&blocks[1]),
            "First line\nsecond line",
            "lines without a blank between them stay one paragraph"
        );
        assert_eq!(plain(&blocks[6]), "two");
        assert_eq!(plain(&blocks[8]), "second");
        assert_eq!(plain(&blocks[9]), "quoted");
        assert_eq!(
            blocks[10],
            json!({"object": "block", "type": "divider", "divider": {}})
        );
        assert_eq!(blocks[11]["object"], "block");
        assert!(markdown_blocks("").is_empty());
        assert!(markdown_blocks("\n\n  \n").is_empty());
    }

    #[test]
    fn markdown_blocks_keep_fenced_code_verbatim() {
        let blocks = markdown_blocks("intro\n```sh\ncargo test\n# not a heading\n```\nafter");
        assert_eq!(kinds(&blocks), ["paragraph", "code", "paragraph"]);
        assert_eq!(blocks[1]["code"]["language"], "plain text");
        assert_eq!(plain(&blocks[1]), "cargo test\n# not a heading");
    }

    #[test]
    fn inline_markdown_becomes_links_and_annotations() {
        let blocks = markdown_blocks(
            "Source: [The Verge](https://www.theverge.com/x) says **big** and *soft* or _quiet_ with `code` and snake_case_name and 2 * 3 * 4.",
        );
        let items = blocks[0]["paragraph"]["rich_text"].as_array().unwrap();
        let rendered: Vec<(String, Value)> = items
            .iter()
            .map(|item| {
                let mut shape = item.clone();
                let content = shape["text"]["content"].as_str().unwrap().to_owned();
                shape["text"].as_object_mut().unwrap().remove("content");
                (content, shape)
            })
            .collect();
        assert_eq!(rendered[0].0, "Source: ");
        assert_eq!(rendered[1].0, "The Verge");
        assert_eq!(
            rendered[1].1["text"]["link"]["url"],
            "https://www.theverge.com/x"
        );
        assert_eq!(rendered[2].0, " says ");
        assert_eq!(rendered[3].0, "big");
        assert_eq!(rendered[3].1["annotations"], json!({"bold": true}));
        assert_eq!(rendered[5].0, "soft");
        assert_eq!(rendered[5].1["annotations"], json!({"italic": true}));
        assert_eq!(rendered[7].0, "quiet");
        assert_eq!(rendered[7].1["annotations"], json!({"italic": true}));
        assert_eq!(rendered[9].0, "code");
        assert_eq!(rendered[9].1["annotations"], json!({"code": true}));
        assert_eq!(
            rendered[10].0, " and snake_case_name and 2 * 3 * 4.",
            "underscores inside words and spaced asterisks stay literal"
        );
        assert!(rendered[0].1.get("annotations").is_none());

        // A relative or unmatched link is left as text; an empty emphasis is literal.
        let blocks = markdown_blocks("see [notes](./notes.md) and [dangling and ** and `");
        assert_eq!(
            plain(&blocks[0]),
            "see [notes](./notes.md) and [dangling and ** and `"
        );
        assert_eq!(
            blocks[0]["paragraph"]["rich_text"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn long_rich_text_is_split_and_block_count_is_capped() {
        let long = "x".repeat(4500);
        let blocks = markdown_blocks(&format!("**{long}**"));
        let items = blocks[0]["paragraph"]["rich_text"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["text"]["content"].as_str().unwrap().len(), 2000);
        assert_eq!(items[2]["text"]["content"].as_str().unwrap().len(), 500);
        assert!(items.iter().all(|item| item["annotations"]["bold"] == true));

        let many = (0..600)
            .map(|i| format!("- item {i}\n"))
            .collect::<Vec<_>>()
            .concat();
        let blocks = markdown_blocks(&many);
        assert_eq!(blocks.len(), MAX_BLOCKS);
        assert_eq!(plain(&blocks[498]), "item 498");
        assert_eq!(blocks[499]["type"], "paragraph");
        assert_eq!(plain(&blocks[499]), TRUNCATED_MARKER);
    }

    #[test]
    fn page_urls_drop_the_dashes() {
        assert_eq!(
            page_url("550e8400-e29b-41d4-a716-446655440000"),
            "https://www.notion.so/550e8400e29b41d4a716446655440000"
        );
    }

    #[tokio::test]
    async fn publishing_without_a_connection_or_destination_fails_before_any_request() {
        let publisher = Publisher::disconnected();
        assert_eq!(
            publisher.publish("Title", "body").await,
            Err(PublishError::Failed(NOT_CONNECTED_MESSAGE.to_owned()))
        );
        let no_destination = Connection {
            access: Access::Token {
                token: "test-token".into(),
            },
            name: "Workspace".into(),
            destination: None,
        };
        assert_eq!(
            publisher
                .publish_with(Some(no_destination), "Title", "body")
                .await,
            Err(PublishError::Failed(NOT_CONNECTED_MESSAGE.to_owned()))
        );
    }
    #[test]
    fn status_never_discloses_a_token() {
        let token = Connection {
            access: Access::Token {
                token: "test-super-secret".into(),
            },
            name: "Workspace".into(),
            destination: None,
        };
        let signed_in: Connection = serde_json::from_value(json!({
            "signIn": {"clientId": "client-secret-id", "accessToken": "access-secret", "refreshToken": "refresh-secret", "expiresAt": 0},
            "name": "Workspace",
        }))
        .unwrap();
        for (connection, via) in [(token, "token"), (signed_in, "signIn")] {
            let status = public_status(Some(&connection));
            assert!(!status.to_string().contains("secret"), "{status}");
            assert_eq!(status["connected"], true);
            assert_eq!(status["via"], via);
        }
    }
    #[test]
    fn a_token_saved_before_sign_in_existed_still_loads() {
        let stored = r#"{"token":"secret_abc","name":"Team space","destination":{"id":"550e8400-e29b-41d4-a716-446655440000","title":"Daily"}}"#;
        let connection: Connection = serde_json::from_str(stored).unwrap();
        assert!(matches!(&connection.access, Access::Token { token } if token == "secret_abc"));
        assert_eq!(connection.destination.as_ref().unwrap().title, "Daily");
        let saved: Value = serde_json::to_value(&connection).unwrap();
        assert_eq!(saved, serde_json::from_str::<Value>(stored).unwrap());

        let signed_in = json!({
            "signIn": {"clientId": "c", "accessToken": "a", "refreshToken": "r", "expiresAt": 7, "workspaceId": "w"},
            "name": "Team space",
            "destination": null,
        });
        let connection: Connection = serde_json::from_value(signed_in.clone()).unwrap();
        assert!(matches!(connection.access, Access::SignIn { .. }));
        assert_eq!(serde_json::to_value(&connection).unwrap(), signed_in);
    }
    #[test]
    fn page_titles_support_custom_title_properties_and_exclude_deleted_pages() {
        let mut input = json!({"id":"550e8400-e29b-41d4-a716-446655440000", "properties":{"Name":{"title":[{"plain_text":"Tech "},{"text":{"content":"News"}}]}}});
        assert_eq!(page(&input).unwrap().title, "Tech News");
        input["in_trash"] = json!(true);
        assert!(page(&input).is_none());
    }
    #[tokio::test]
    async fn rejects_cross_origin_and_simple_mutations_before_touching_keychain() {
        for (origin, marker) in [("https://evil.example", true), ("http://localhost", false)] {
            let mut request = Request::builder()
                .uri("/api/notion/connection")
                .method("DELETE")
                .header(header::HOST, "localhost")
                .header(header::ORIGIN, origin);
            if marker {
                request = request.header("x-loomwatch-request", "1");
            }
            let response = router()
                .unwrap()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }

    // -----------------------------------------------------------------------------------
    // Notion sign-in, end to end against a stand-in for Notion's authorization and MCP server
    // -----------------------------------------------------------------------------------

    const DESTINATION: &str = "550e8400-e29b-41d4-a716-446655440000";
    const DATABASE: &str = "650e8400-e29b-41d4-a716-446655440000";
    const EXISTING: &str = "750e8400-e29b-41d4-a716-446655440000";
    const CREATED: &str = "850e8400-e29b-41d4-a716-446655440000";

    fn notion_url(id: &str) -> String {
        format!("https://app.notion.com/p/{}", id.replace('-', ""))
    }

    /// What the stand-in has been asked and what it will accept next.
    #[derive(Default)]
    struct Fake {
        mcp: String,
        redirect_uri: String,
        challenge: String,
        access: String,
        refresh: String,
        revoked: Vec<String>,
        tools: Vec<(String, Value)>,
    }
    type Shared = Arc<std::sync::Mutex<Fake>>;

    async fn fake_register(State(fake): State<Shared>, Json(body): Json<Value>) -> Json<Value> {
        assert_eq!(body["token_endpoint_auth_method"], "none");
        assert_eq!(body["client_name"], "LoomWatch");
        fake.lock().unwrap().redirect_uri = body["redirect_uris"][0].as_str().unwrap().to_owned();
        Json(json!({"client_id": "client-1"}))
    }

    async fn fake_token(State(fake): State<Shared>, body: String) -> Response {
        let form: std::collections::HashMap<String, String> =
            url::form_urlencoded::parse(body.as_bytes())
                .into_owned()
                .collect();
        let mut fake = fake.lock().unwrap();
        assert_eq!(form["client_id"], "client-1");
        match form.get("grant_type").map(String::as_str) {
            Some("authorization_code") => {
                assert_eq!(form["code"], "code-1");
                assert_eq!(form["redirect_uri"], fake.redirect_uri);
                assert_eq!(form["resource"], fake.mcp);
                // PKCE: only the holder of the verifier behind the challenge gets a token.
                let digest =
                    <sha2::Sha256 as sha2::Digest>::digest(form["code_verifier"].as_bytes());
                assert_eq!(
                    base64::Engine::encode(
                        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                        digest
                    ),
                    fake.challenge
                );
                "access-1".clone_into(&mut fake.access);
                "refresh-1".clone_into(&mut fake.refresh);
                Json(json!({"access_token": "access-1", "refresh_token": "refresh-1", "expires_in": 3600, "workspace_name": "Acme", "workspace_id": "ws-1"})).into_response()
            }
            Some("refresh_token") if form["refresh_token"] == fake.refresh => {
                "access-2".clone_into(&mut fake.access);
                "refresh-2".clone_into(&mut fake.refresh);
                Json(json!({"access_token": "access-2", "refresh_token": "refresh-2", "expires_in": 3600})).into_response()
            }
            Some(_) => (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "invalid_grant"})),
            )
                .into_response(),
            None => {
                fake.revoked.push(form["token"].clone());
                StatusCode::OK.into_response()
            }
        }
    }

    async fn fake_mcp(
        State(fake): State<Shared>,
        headers: HeaderMap,
        Json(message): Json<Value>,
    ) -> Response {
        let mut fake = fake.lock().unwrap();
        if headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            != Some(format!("Bearer {}", fake.access).as_str())
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let Some(id) = message.get("id").cloned() else {
            return StatusCode::ACCEPTED.into_response();
        };
        let answer = |result: Value| json!({"jsonrpc": "2.0", "id": id, "result": result});
        let text = |value: Value| json!({"content": [{"type": "text", "text": value.to_string()}]});
        match message["method"].as_str().unwrap() {
            "initialize" => (
                [("mcp-session-id", "session-1")],
                Json(answer(json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fake"}}))),
            )
                .into_response(),
            "tools/call" => {
                assert_eq!(headers["mcp-session-id"], "session-1");
                assert_eq!(headers["mcp-protocol-version"], "2025-06-18");
                let name = message["params"]["name"].as_str().unwrap().to_owned();
                let arguments = message["params"]["arguments"].clone();
                fake.tools.push((name.clone(), arguments));
                match name.as_str() {
                    // Search answers as an event stream, after a progress notification.
                    "notion-search" => (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        format!(
                            "event: message\ndata: {}\n\nevent: message\ndata: {}\n\n",
                            json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": {}}),
                            answer(text(json!({"type": "workspace_search", "results": [
                                {"id": DESTINATION, "title": "Daily", "type": "page", "url": notion_url(DESTINATION)},
                                {"id": DATABASE, "title": "Tasks", "type": "database", "url": notion_url(DATABASE)},
                            ]}))),
                        ),
                    )
                        .into_response(),
                    // As Notion fetches a page: wrapped in its own <page>, children as leaves.
                    "notion-fetch" => Json(answer(text(json!({
                        "metadata": {"type": "page"},
                        "title": "Daily",
                        "url": notion_url(DESTINATION),
                        "text": format!(
                            "<page url=\"{}\">\n<properties>{{\"title\":\"Daily\"}}</properties>\n<content>\nIntro\n<page url=\"{}\">Existing</page>\n</content>\n</page>",
                            notion_url(DESTINATION),
                            notion_url(EXISTING),
                        ),
                    }))))
                    .into_response(),
                    "notion-create-pages" => Json(answer(text(json!({"pages": [
                        {"id": CREATED, "url": notion_url(CREATED)},
                    ]}))))
                    .into_response(),
                    "notion-update-page" => Json(answer(text(json!({"id": CREATED})))).into_response(),
                    other => panic!("unexpected tool {other}"),
                }
            }
            other => panic!("unexpected method {other}"),
        }
    }

    async fn fake_notion() -> (Endpoints, Shared) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let fake: Shared = Arc::default();
        format!("{base}/mcp").clone_into(&mut fake.lock().unwrap().mcp);
        let app = Router::new()
            .route("/register", post(fake_register))
            .route("/token", post(fake_token))
            .route("/mcp", post(fake_mcp))
            .with_state(fake.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let endpoints = Endpoints {
            api: format!("{base}/v1"),
            mcp: format!("{base}/mcp"),
            authorize: format!("{base}/authorize"),
            token: format!("{base}/token"),
            register: format!("{base}/register"),
            revoke: format!("{base}/token"),
        };
        (endpoints, fake)
    }

    async fn send(
        router: &Router,
        request: axum::http::request::Builder,
        body: Option<Value>,
    ) -> (StatusCode, HeaderMap, Value) {
        let request = request.header(header::HOST, "127.0.0.1:3000");
        let request = match body {
            Some(body) => request
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        };
        let response = router.clone().oneshot(request.unwrap()).await.unwrap();
        let (parts, body) = response.into_parts();
        let bytes = http_body_util::BodyExt::collect(body)
            .await
            .unwrap()
            .to_bytes();
        (
            parts.status,
            parts.headers,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// The UI's own request: same origin, with the marker header.
    fn from_ui(method: &str, uri: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("x-loomwatch-request", "1")
            .header("sec-fetch-site", "same-origin")
    }

    /// Notion sending the browser back: a top-level navigation from another site.
    fn from_notion(query: &str) -> axum::http::request::Builder {
        Request::builder()
            .uri(format!("{}?{query}", sign_in::CALLBACK))
            .header("sec-fetch-site", "cross-site")
    }

    async fn start(router: &Router, fake: &Shared) -> String {
        let (status, _, body) = send(router, from_ui("POST", "/api/notion/sign-in"), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let consent = url::Url::parse(body["url"].as_str().unwrap()).unwrap();
        let query: std::collections::HashMap<String, String> =
            consent.query_pairs().into_owned().collect();
        assert_eq!(query["client_id"], "client-1");
        assert_eq!(
            query["redirect_uri"],
            "http://127.0.0.1:3000/api/notion/sign-in/callback"
        );
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["resource"], fake.lock().unwrap().mcp);
        fake.lock().unwrap().challenge = query["code_challenge"].clone();
        query["state"].clone()
    }

    fn stored(slot: &Arc<std::sync::Mutex<Option<String>>>) -> Value {
        slot.lock()
            .unwrap()
            .as_deref()
            .map_or(Value::Null, |value| serde_json::from_str(value).unwrap())
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)] // one story, told in order: sign in, renew, search, publish, disconnect
    async fn signing_in_renews_searches_publishes_and_disconnects_through_notion_mcp() {
        let (endpoints, fake) = fake_notion().await;
        let slot: Arc<std::sync::Mutex<Option<String>>> = Arc::default();
        let store = Store::Memory(slot.clone());
        let router = router_with(NotionState {
            client: build_client().unwrap(),
            gate: Arc::default(),
            store: store.clone(),
            endpoints: Arc::new(endpoints.clone()),
            pending: Arc::default(),
        });

        // Starting is the UI's call alone; finishing is open to Notion's redirect, but only
        // on this computer, and only with the state of the sign-in in progress.
        let (status, _, _) = send(
            &router,
            Request::builder().method("POST").uri("/api/notion/sign-in"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let state = start(&router, &fake).await;
        let (status, _, _) = send(
            &router,
            from_notion(&format!("state={state}&code=code-1")).header(header::HOST, "evil.example"),
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "a rebound host never reaches the callback"
        );
        let (status, headers, _) =
            send(&router, from_notion("state=forged&code=code-1"), None).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        assert_eq!(headers[header::LOCATION], "/connections?notion=expired");
        let (status, headers, _) = send(
            &router,
            from_notion(&format!("state={state}&code=code-1")),
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::SEE_OTHER,
            "the forged visit left the real sign-in waiting"
        );
        assert_eq!(headers[header::LOCATION], "/connections?notion=connected");
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
        let (_, headers, _) = send(
            &router,
            from_notion(&format!("state={state}&code=code-1")),
            None,
        )
        .await;
        assert_eq!(
            headers[header::LOCATION],
            "/connections?notion=expired",
            "a state is used once"
        );

        let (_, _, connection) =
            send(&router, from_ui("GET", "/api/notion/connection"), None).await;
        assert_eq!(
            connection,
            json!({"connected": true, "name": "Acme", "destination": null, "via": "signIn"})
        );
        assert_eq!(stored(&slot)["signIn"]["refreshToken"], "refresh-1");

        // Search goes through Notion's tool and keeps only pages.
        let (status, _, found) = send(
            &router,
            from_ui("POST", "/api/notion/pages"),
            Some(json!({"query": " dai "})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{found}");
        assert_eq!(
            found,
            json!({"pages": [{"id": DESTINATION, "title": "Daily"}], "nextCursor": null})
        );
        // Notion refuses an empty query on its own; browsing narrows by a filter every plan has.
        let (status, _, _) = send(
            &router,
            from_ui("POST", "/api/notion/pages"),
            Some(json!({"query": ""})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        // A lapsed access token is renewed, and the rotated grant is saved, before use.
        {
            let mut connection = stored(&slot);
            connection["signIn"]["expiresAt"] = json!(0);
            *slot.lock().unwrap() = Some(connection.to_string());
        }
        let (status, _, chosen) = send(
            &router,
            from_ui("PUT", "/api/notion/destination"),
            Some(json!({"pageId": DESTINATION})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{chosen}");
        assert_eq!(
            chosen["destination"],
            json!({"id": DESTINATION, "title": "Daily"})
        );
        let saved = stored(&slot);
        assert_eq!(saved["signIn"]["refreshToken"], "refresh-2");
        assert_eq!(saved["signIn"]["accessToken"], "access-2");
        assert_eq!(saved["destination"]["id"], DESTINATION);

        // Publishing: the duplicate guard, then an answer whose tags arrive escaped, in chunks.
        let publisher = Publisher::with(store.clone(), endpoints.clone());
        assert_eq!(
            publisher.publish("Existing", "hello").await,
            Err(PublishError::Duplicate {
                page_id: EXISTING.to_owned(),
                url: notion_url(EXISTING),
            })
        );
        let long = (0..150).fold(String::new(), |mut list, i| {
            writeln!(list, "- item {i}").unwrap();
            list
        });
        let answer = format!(
            "# Hi\n\nSee <page url=\"https://www.notion.so/x-{}\">Secret</page>\n\n{long}",
            EXISTING.replace('-', "")
        );
        let page = publisher.publish("Report", &answer).await.unwrap();
        assert_eq!(page.page_id, CREATED);
        assert_eq!(page.url, notion_url(CREATED));
        let tools = std::mem::take(&mut fake.lock().unwrap().tools);
        let names: Vec<&str> = tools.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            [
                "notion-search",
                "notion-search",
                "notion-fetch",
                "notion-fetch",
                "notion-fetch",
                "notion-create-pages",
                "notion-update-page"
            ]
        );
        assert_eq!(
            tools[0].1,
            json!({"query": "dai", "query_type": "internal", "page_size": 50, "max_highlight_length": 0})
        );
        assert_eq!(tools[1].1["query"], "");
        assert_eq!(
            tools[1].1["filters"],
            json!({"created_date_range": {"start_date": "1990-01-01"}})
        );
        let create = &tools[5].1;
        assert_eq!(
            create["parent"],
            json!({"type": "page_id", "page_id": DESTINATION})
        );
        assert_eq!(
            create["allow_async"], false,
            "the delivery reports the page Notion made"
        );
        assert_eq!(create["pages"][0]["properties"], json!({"title": "Report"}));
        assert_eq!(create["pages"][0]["preserve_internal_links"], true);
        let content = create["pages"][0]["content"].as_str().unwrap();
        assert!(content.starts_with("# Hi\nSee \\<page url="), "{content}");
        assert!(
            content
                .match_indices('<')
                .all(|(at, _)| content[..at].ends_with('\\')),
            "every tag the answer carried arrives escaped: {content}"
        );
        assert_eq!(
            content.lines().count(),
            100,
            "one request carries at most 100 blocks"
        );
        let append = &tools[6].1;
        assert_eq!(append["page_id"], CREATED);
        assert_eq!(append["command"], "insert_content");
        assert_eq!(append["position"], json!({"type": "end"}));
        assert_eq!(append["allow_async"], false, "chunks land in order");
        assert_eq!(append["content"].as_str().unwrap().lines().count(), 52);

        // Disconnecting forgets the grant here and asks Notion to revoke it.
        let (_, _, connection) =
            send(&router, from_ui("DELETE", "/api/notion/connection"), None).await;
        assert_eq!(connection, json!({"connected": false}));
        assert_eq!(stored(&slot), Value::Null);
        assert_eq!(fake.lock().unwrap().revoked, ["refresh-2"]);
    }

    #[tokio::test]
    async fn a_declined_or_lapsed_sign_in_says_so_and_keeps_nothing() {
        let (endpoints, fake) = fake_notion().await;
        let slot: Arc<std::sync::Mutex<Option<String>>> = Arc::default();
        let router = router_with(NotionState {
            client: build_client().unwrap(),
            gate: Arc::default(),
            store: Store::Memory(slot.clone()),
            endpoints: Arc::new(endpoints),
            pending: Arc::default(),
        });
        let state = start(&router, &fake).await;
        let (_, headers, _) = send(
            &router,
            from_notion(&format!("state={state}&error=access_denied")),
            None,
        )
        .await;
        assert_eq!(headers[header::LOCATION], "/connections?notion=denied");
        assert_eq!(stored(&slot), Value::Null);

        // Notion refusing the renewal means signing in again, in the words every surface uses.
        let state = start(&router, &fake).await;
        send(
            &router,
            from_notion(&format!("state={state}&code=code-1")),
            None,
        )
        .await;
        {
            let mut connection = stored(&slot);
            connection["signIn"]["expiresAt"] = json!(0);
            connection["signIn"]["refreshToken"] = json!("retired");
            *slot.lock().unwrap() = Some(connection.to_string());
        }
        let (status, _, body) = send(
            &router,
            from_ui("POST", "/api/notion/pages"),
            Some(json!({"query": ""})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], sign_in::SIGN_IN_AGAIN);
    }
}
