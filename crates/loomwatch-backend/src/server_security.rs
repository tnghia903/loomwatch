//! Authentication at the outer router, independent of Host and browser metadata.
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

#[derive(Clone)]
pub struct Access {
    bearer: String,
    basic: String,
}

impl Access {
    /// Build the network listener's credential. Browsers use HTTP Basic (user `loomwatch`),
    /// clients may use Bearer. The token must be generated randomly by the operator.
    ///
    /// # Errors
    /// Rejects tokens shorter than 32 bytes or containing whitespace.
    pub fn new(token: &str) -> anyhow::Result<Self> {
        anyhow::ensure!(
            token.len() >= 32 && !token.chars().any(char::is_whitespace),
            "non-loopback serving requires a random LOOMWATCH_SERVER_TOKEN of at least 32 characters"
        );
        Ok(Self {
            bearer: format!("Bearer {token}"),
            basic: format!("Basic {}", base64(format!("loomwatch:{token}").as_bytes())),
        })
    }
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::new();
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        encoded.push(char::from(ALPHABET[((n >> 18) & 63) as usize]));
        encoded.push(char::from(ALPHABET[((n >> 12) & 63) as usize]));
        encoded.push(if chunk.len() > 1 {
            char::from(ALPHABET[((n >> 6) & 63) as usize])
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            char::from(ALPHABET[(n & 63) as usize])
        } else {
            '='
        });
    }
    encoded
}

fn matches_secret(supplied: &[u8], expected: &[u8]) -> bool {
    if supplied.len() != expected.len() {
        return false;
    }
    supplied
        .iter()
        .zip(expected)
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

pub async fn authenticate(State(access): State<Access>, request: Request, next: Next) -> Response {
    // Control MCP performs its own mandatory scoped bearer validation. Health has no data.
    if matches!(request.uri().path(), "/api/health" | "/api/control/mcp") {
        return next.run(request).await;
    }
    let valid = request
        .headers()
        .get(header::AUTHORIZATION)
        .is_some_and(|value| {
            matches_secret(value.as_bytes(), access.bearer.as_bytes())
                || matches_secret(value.as_bytes(), access.basic.as_bytes())
        });
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            [
                (
                    header::WWW_AUTHENTICATE,
                    "Basic realm=\"LoomWatch\", charset=\"UTF-8\"",
                ),
                (header::CACHE_CONTROL, "no-store"),
            ],
            "Authentication required",
        )
            .into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, middleware, routing::get};
    use tower::ServiceExt;
    #[tokio::test]
    async fn spoofed_local_host_does_not_authenticate() {
        let token = "a-random-example-token-with-32-characters";
        let access = Access::new(token).unwrap();
        let basic = access.basic.clone();
        let app = Router::new()
            .route("/api/team", get(|| async { "secret" }))
            .layer(middleware::from_fn_with_state(access, authenticate));
        for authorization in [None, Some("Bearer wrong"), Some(basic.as_str())] {
            let mut request = axum::http::Request::get("/api/team").header("host", "localhost");
            if let Some(value) = authorization {
                request = request.header(header::AUTHORIZATION, value);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                if authorization == Some(basic.as_str()) {
                    StatusCode::OK
                } else {
                    StatusCode::UNAUTHORIZED
                }
            );
        }
    }
}
