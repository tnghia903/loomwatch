//! Embedded single-page application served by `loomwatchd`.

use axum::Router;
use axum::body::Body;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../ui/dist/"]
struct UiAssets;

const INDEX_PATH: &str = "index.html";
const NO_CACHE: &str = "no-cache";
const IMMUTABLE_CACHE: &str = "public, max-age=31536000, immutable";

/// Create the UI router. More-specific API routes can be merged into it without the
/// SPA fallback intercepting them.
pub fn router() -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/", get(index))
        .route("/{*path}", get(asset_or_index))
}

async fn health() -> &'static str {
    "ok"
}

async fn index() -> Response {
    embedded_response(INDEX_PATH, false)
}

async fn asset_or_index(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path == "api" || path.starts_with("api/") {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"error": "API route not found"})),
        )
            .into_response();
    }
    if UiAssets::get(path).is_some() {
        embedded_response(path, path.starts_with("assets/"))
    } else {
        embedded_response(INDEX_PATH, false)
    }
}

fn embedded_response(path: &str, immutable: bool) -> Response {
    let Some(asset) = UiAssets::get(path) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "embedded UI is missing index.html",
        )
            .into_response();
    };
    let content_type = mime_guess::from_path(path).first_or_octet_stream();
    let cache_control = if immutable { IMMUTABLE_CACHE } else { NO_CACHE };

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type.as_ref())
        .header(CACHE_CONTROL, cache_control)
        .header("content-security-policy", "frame-ancestors 'none'")
        .header("x-frame-options", "DENY")
        .body(Body::from(asset.data))
        .expect("static response headers are valid")
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Method, Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn serves_the_embedded_index() {
        let response = router()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "text/html");
        assert_eq!(response.headers()[CACHE_CONTROL], NO_CACHE);
        assert_eq!(
            response.headers()["content-security-policy"],
            "frame-ancestors 'none'"
        );
        assert_eq!(response.headers()["x-frame-options"], "DENY");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(
            body.windows(b"id=\"root\"".len())
                .any(|window| window == b"id=\"root\"")
        );
    }

    #[tokio::test]
    async fn falls_back_to_index_for_client_side_routes() {
        let root = router()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap()
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let fallback = router()
            .oneshot(
                Request::get("/teams/example/inspect")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(fallback.status(), StatusCode::OK);
        assert_eq!(fallback.headers()[CONTENT_TYPE], "text/html");
        assert_eq!(
            fallback.into_body().collect().await.unwrap().to_bytes(),
            root
        );
    }

    #[tokio::test]
    async fn serves_fingerprinted_assets_with_long_lived_caching() {
        let asset_path = UiAssets::iter()
            .find(|path| path.starts_with("assets/") && path.ends_with(".js"))
            .expect("the Vite build should contain a JavaScript asset");
        let response = router()
            .oneshot(
                Request::get(format!("/{asset_path}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CACHE_CONTROL], IMMUTABLE_CACHE);
        assert!(
            !response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn rejects_non_get_requests_instead_of_hiding_missing_api_routes() {
        let response = router()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/unknown")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn specific_api_routes_take_precedence_over_the_spa_catch_all() {
        let response = router()
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            "ok"
        );
    }
}
