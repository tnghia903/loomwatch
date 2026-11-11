//! The figure an agent wears in Your agents: one of six builds in one of six colours, and what the
//! wardrobe holds (docs/QUESTS.md). `ui/src/lib/library/figures.ts` and `ui/src/lib/quests/catalog.ts`
//! are the twin: change both, and keep `migrate_*`'s cases the same as `figures.test.ts`.
//!
//! An earlier `LoomWatch` drew sewing-box figures (a yarn ball, a spool…) and dressed them in sewing
//! things. Their names still sit in agents' files and in `wardrobe.json`, so every place that reads
//! one maps it first: nobody's agent loses its figure, and nothing earned is lost.

/// The six builds, in the order an agent nobody dressed is given one (`pick`): each sits where the
/// old figure of the same shape sat (yarn, spool, button, thimble, pincushion, cone), so such an
/// agent keeps the look it had.
pub(crate) const BUILDS: &[&str] = &["chubby", "tall", "wide", "little", "egg", "slim"];

/// The colours anyone can choose. None is a state colour: green ready, blue working, gold waiting,
/// red failed.
pub(crate) const STARTER_COLORS: &[&str] = &["clay", "sage", "sky", "lilac", "rose", "orchid"];

/// The finishes a quest earns (`crate::wardrobe::FIGURE_ITEMS`): any build can be one once earned.
pub(crate) const EARNED_COLORS: &[&str] = &["plum", "sunset"];

/// The colours `pick` chooses from: the old seven, renamed. An agent nobody dressed was given one
/// of seven by its id; with the same seven, renamed, it keeps the colour it had.
const PICK_COLORS: &[&str] = &["clay", "clay", "sage", "sky", "lilac", "rose", "orchid"];

/// What a figure wears, in the order the layers stack: the clothes first (the first four, worn one
/// at a time; the app's `GARMENTS`), then the rest.
pub(crate) const ACCESSORIES: &[&str] = &[
    "striped_top",
    "cardigan",
    "black_dress",
    "trench_coat",
    "ballet_flats",
    "gloves",
    "coffee",
    "collar",
    "silk_scarf",
    "beret",
    "bow",
];

pub(crate) fn is_build(kind: &str) -> bool {
    BUILDS.contains(&kind)
}

pub(crate) fn is_color(color: &str) -> bool {
    STARTER_COLORS.contains(&color) || EARNED_COLORS.contains(&color)
}

/// A figure's build and colour under today's names. The old sewing figures become the build of the
/// same shape; the two that were earned become a build in the finish that is earned now. Butter and
/// oat, retired colours, become clay and orchid. Today's names, and names this build does not know,
/// pass through unchanged, for the caller to accept or refuse.
pub(crate) fn migrate_figure(kind: &str, color: &str) -> (String, String) {
    let (kind, earned) = match kind {
        "yarn" => ("chubby", None),
        "spool" => ("tall", None),
        "button" => ("wide", None),
        "thimble" => ("little", None),
        "pincushion" => ("egg", None),
        "cone" => ("slim", None),
        "scissors" => ("slim", Some("plum")),
        "bobbin" => ("tall", Some("sunset")),
        other => (other, None),
    };
    let color = earned.unwrap_or(match color {
        "butter" => "clay",
        "oat" => "orchid",
        other => other,
    });
    (kind.to_owned(), color.to_owned())
}

/// A wardrobe item under today's name: each sewing item becomes the fashion item that rewards the
/// same quest, and the two earned figures become the two earned finishes. The sunglasses, pearls and
/// handbag became the beret, the round collar and the coffee to go (2026-11-09).
pub(crate) fn migrate_item(item: &str) -> &str {
    match item {
        "tee" => "striped_top",
        "overalls" => "cardigan",
        "apron" => "black_dress",
        "vest" => "trench_coat",
        "chalk" => "bow",
        "band" | "handbag" => "coffee",
        "pin" => "gloves",
        "cushion" => "ballet_flats",
        "shuttle" => "silk_scarf",
        "monocle" | "sunglasses" => "beret",
        "patch" | "pearls" => "collar",
        "scissors" => "plum",
        "bobbin" => "sunset",
        other => other,
    }
}

/// The figure an agent nobody dressed wears, from a hash of its id: the same every time, and the
/// same as the app's `figureFor`.
pub(crate) fn pick(seed: u32) -> (&'static str, &'static str) {
    let builds = u32::try_from(BUILDS.len()).unwrap_or(1);
    let colors = u32::try_from(PICK_COLORS.len()).unwrap_or(1);
    (
        BUILDS[(seed % builds) as usize],
        PICK_COLORS[((seed / builds) % colors) as usize],
    )
}

/// The job icons an agent may name (`schemas/job-icons.json`, the app's `ROLE_ICON_IDS`): each is
/// the sign a figure of that job wears on its head.
pub(crate) const JOB_ICONS: &[&str] = &[
    "research",
    "write",
    "edit",
    "review",
    "code",
    "design",
    "analyse",
    "slides",
    "document",
    "sheet",
    "chart",
    "dashboard",
    "video",
];

/// The sign of an agent with no job's icon: a plain curl.
pub(crate) const PLAIN_SIGN: &str = "curl";

/// How a word in [`ICON_WORDS`] ends: anywhere, so `investigat` finds "investigate" (a pattern
/// with no closing `\b`), or where a word does (one that closes with `\b`).
#[derive(Clone, Copy)]
enum Ends {
    Anywhere,
    Word,
}

/// `ICON_WORDS` in `ui/src/lib/library/roleIcons.ts`, the twin: the same patterns in the same order, each
/// spelled out as the words it matches at the start of a word, `|` between them. `slides?` is
/// `slide|slides`, `voice-?over` is `voice-over|voiceover` and `analy[sz]` is `analys|analyz`. The
/// design pattern's `ui\b` is the one word that must end where a word does, so it has a line of its
/// own.
const ICON_WORDS: &[(&str, Ends, &str)] = &[
    (
        "review",
        Ends::Anywhere,
        "review|check|critic|qa|verif|audit|approv",
    ),
    (
        "edit",
        Ends::Anywhere,
        "edit|proofread|polish|tighten|copyedit",
    ),
    (
        "research",
        Ends::Anywhere,
        "research|search|find|source|scout|investigat",
    ),
    (
        "slides",
        Ends::Word,
        "slide|slides|deck|presentation|powerpoint|pptx",
    ),
    ("sheet", Ends::Word, "spreadsheet|workbook|excel|xlsx"),
    ("dashboard", Ends::Word, "dashboard|dashboards"),
    ("chart", Ends::Word, "chart|charts|graph|graphs|plot|plots"),
    (
        "video",
        Ends::Word,
        "video|videos|clip|clips|voice-over|voiceover|animation",
    ),
    (
        "document",
        Ends::Word,
        "word document|word documents|docx|pdf|pdfs",
    ),
    (
        "analyse",
        Ends::Anywhere,
        "analys|analyz|data|metric|number|statistic",
    ),
    ("design", Ends::Anywhere, "design|visual|layout|diagram"),
    ("design", Ends::Word, "ui"),
    (
        "code",
        Ends::Anywhere,
        "code|coder|develop|engineer|program|bug|test|refactor",
    ),
    (
        "write",
        Ends::Word,
        "write|writer|draft|author|copy|blog|post|note|notes",
    ),
];

/// A letter, digit or underscore: what JavaScript's `\b` takes for part of a word. Any other
/// character, every one past ASCII among them, is not, as in a pattern without the `u` flag.
fn in_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Whether `word` starts a word somewhere in `text`, and, when it must, ends one there too.
fn says(text: &str, word: &str, ends: Ends) -> bool {
    let bytes = text.as_bytes();
    text.match_indices(word).any(|(at, _)| {
        let starts = at == 0 || !in_word(bytes[at - 1]);
        let end = at + word.len();
        starts && (matches!(ends, Ends::Anywhere) || end == bytes.len() || !in_word(bytes[end]))
    })
}

/// `guessIcon`: an icon for a job from its name, then its instructions; none when nothing fits.
pub(crate) fn guess_icon(name: &str, instructions: &str) -> Option<&'static str> {
    [name, instructions].into_iter().find_map(|text| {
        let lower = text.to_lowercase();
        ICON_WORDS
            .iter()
            .find(|(_, ends, words)| words.split('|').any(|word| says(&lower, word, *ends)))
            .map(|(icon, _, _)| *icon)
    })
}

/// `signFor`: the sign on an agent's figure. Its saved job's icon when that is a job's, else the
/// one its name and instructions suggest, else a plain curl. It comes from the agent, never from
/// the figure a person picks, and it is only for drawing: a saved figure never holds one.
pub(crate) fn sign_for(icon: Option<&str>, name: &str, instructions: &str) -> &'static str {
    icon.and_then(|icon| JOB_ICONS.iter().find(|known| **known == icon))
        .copied()
        .or_else(|| guess_icon(name, instructions))
        .unwrap_or(PLAIN_SIGN)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The same cases as ui/src/lib/library/figures.test.ts "maps every old figure".
    #[test]
    fn maps_every_old_figure_to_a_build_and_colour_that_exist() {
        let cases = [
            (("yarn", "clay"), ("chubby", "clay")),
            (("spool", "butter"), ("tall", "clay")),
            (("button", "sage"), ("wide", "sage")),
            (("thimble", "sky"), ("little", "sky")),
            (("pincushion", "lilac"), ("egg", "lilac")),
            (("cone", "oat"), ("slim", "orchid")),
            (("scissors", "rose"), ("slim", "plum")),
            (("bobbin", "oat"), ("tall", "sunset")),
            (("tall", "orchid"), ("tall", "orchid")),
            (("egg", "sunset"), ("egg", "sunset")),
        ];
        for ((kind, color), (want_kind, want_color)) in cases {
            let (got_kind, got_color) = migrate_figure(kind, color);
            assert_eq!(
                (got_kind.as_str(), got_color.as_str()),
                (want_kind, want_color),
                "{kind} {color}"
            );
            assert!(is_build(&got_kind) && is_color(&got_color));
        }
        assert_eq!(
            migrate_figure("teapot", "mauve"),
            ("teapot".to_owned(), "mauve".to_owned())
        );
    }

    #[test]
    fn maps_every_old_wardrobe_item_to_one_that_rewards_the_same_quest() {
        let cases = [
            ("tee", "striped_top"),
            ("overalls", "cardigan"),
            ("apron", "black_dress"),
            ("vest", "trench_coat"),
            ("chalk", "bow"),
            ("band", "coffee"),
            ("pin", "gloves"),
            ("cushion", "ballet_flats"),
            ("shuttle", "silk_scarf"),
            ("monocle", "beret"),
            ("patch", "collar"),
            ("scissors", "plum"),
            ("bobbin", "sunset"),
            ("handbag", "coffee"),
            ("pearls", "collar"),
            ("sunglasses", "beret"),
        ];
        for (old, new) in cases {
            assert_eq!(migrate_item(old), new);
            assert!(
                ACCESSORIES.contains(&new) || EARNED_COLORS.contains(&new),
                "{new}"
            );
        }
        for item in ACCESSORIES {
            assert_eq!(migrate_item(item), *item);
        }
    }

    // The same cases as ui/src/lib/library/figures.test.ts "the sign on a figure's head", the twin.
    #[test]
    fn the_sign_on_a_figures_head_is_its_jobs_icon_else_what_its_name_suggests_else_a_curl() {
        assert_eq!(sign_for(Some("review"), "Ada", ""), "review");
        assert_eq!(sign_for(None, "Trip writer", ""), "write");
        assert_eq!(sign_for(None, "Ada", "Analyse the sales data."), "analyse");
        assert_eq!(sign_for(None, "Ada", ""), "curl");
        // An icon that is no job's is not a sign.
        assert_eq!(sign_for(Some("crown"), "Ada", ""), "curl");
        assert_eq!(sign_for(Some("crown"), "Researcher", ""), "research");
    }

    // The same cases as ui/src/lib/library/jobs.test.ts "guesses an icon from the name before the
    // instructions", the twin.
    #[test]
    fn guesses_an_icon_from_the_name_before_the_instructions() {
        assert_eq!(
            guess_icon("Fact checker", "Write a summary"),
            Some("review")
        );
        assert_eq!(
            guess_icon("Helper", "Analyse the sales data"),
            Some("analyse")
        );
        assert_eq!(guess_icon("Helper", "Be nice"), None);
        // A maker's word wins over the older, wider ones.
        assert_eq!(guess_icon("Pitch deck designer", ""), Some("slides"));
        assert_eq!(guess_icon("Budget spreadsheet", ""), Some("sheet"));
        assert_eq!(guess_icon("Sales data dashboard", ""), Some("dashboard"));
        assert_eq!(
            guess_icon("Helper", "Turn the data into charts"),
            Some("chart")
        );
        assert_eq!(guess_icon("Promo video", ""), Some("video"));
        assert_eq!(
            guess_icon("Board pack", "Make a Word document from the notes"),
            Some("document")
        );
        assert_eq!(guess_icon("Data analyst", ""), Some("analyse"));
    }

    // Where a word starts and ends, as JavaScript's `\b` reads it.
    #[test]
    fn a_word_counts_only_where_a_word_starts_and_where_its_pattern_ends_it() {
        // Inside another word it is not that word: "update" holds "data", "subplot" "plot", and
        // "guided" "ui".
        assert_eq!(guess_icon("Update helper", ""), None);
        assert_eq!(guess_icon("Subplot helper", ""), None);
        assert_eq!(guess_icon("Guided tour", ""), None);
        // A pattern with no closing `\b` matches the start of a longer word…
        assert_eq!(guess_icon("Investigator", ""), Some("research"));
        // …and one that closes with it does not: a plotter is no plot, a uikit no UI.
        assert_eq!(guess_icon("Plotter", ""), None);
        assert_eq!(guess_icon("Uikit helper", ""), None);
        assert_eq!(guess_icon("UI-kit maker", ""), Some("design"));
        assert_eq!(guess_icon("Voice-over maker", ""), Some("video"));
        assert_eq!(guess_icon("Voiceover maker", ""), Some("video"));
        // Past ASCII is no part of a word, as without the `u` flag: "é" ends the word before it.
        assert_eq!(guess_icon("Postés", ""), Some("write"));
    }

    #[test]
    fn every_job_icon_is_a_sign() {
        #[derive(serde::Deserialize)]
        struct IconsFile {
            icons: Vec<String>,
        }
        let schema: IconsFile =
            serde_json::from_str(include_str!("../../../schemas/job-icons.json")).expect("icons");
        assert_eq!(schema.icons, JOB_ICONS);
        for (icon, _, _) in ICON_WORDS {
            assert!(JOB_ICONS.contains(icon), "{icon}");
        }
    }

    // An agent nobody dressed keeps its look: the build and colour picked now are the old pick's,
    // renamed. The old pick was (STARTER_KINDS[seed % 6], the old seven colours[seed / 6 % 7]).
    #[test]
    fn an_agent_nobody_dressed_keeps_its_look() {
        let old_kinds = ["yarn", "spool", "button", "thimble", "pincushion", "cone"];
        let old_colors = ["clay", "butter", "sage", "sky", "lilac", "rose", "oat"];
        for seed in [0_u32, 1, 5, 6, 41, 42, 1_000_003, u32::MAX] {
            let old = migrate_figure(
                old_kinds[(seed % 6) as usize],
                old_colors[((seed / 6) % 7) as usize],
            );
            let (kind, color) = pick(seed);
            assert_eq!((kind.to_owned(), color.to_owned()), old, "seed {seed}");
        }
    }
}
