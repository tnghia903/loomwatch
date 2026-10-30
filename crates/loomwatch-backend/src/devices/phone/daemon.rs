//! Calling `LoomWatch` on this computer, at its own address, as any local program does.

use anyhow::{Context, Result, bail};
use axum::body::Bytes;
use axum::http::{HeaderValue, Method};
use serde_json::Value;

pub struct Daemon {
    client: reqwest::Client,
    /// `LoomWatch`'s own address, such as `http://127.0.0.1:3000`.
    base: String,
}

impl Daemon {
    #[must_use]
    pub fn at(address: &str) -> Self {
        Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("a client with no proxy and default TLS settings builds"),
            base: address.trim_end_matches('/').to_owned(),
        }
    }

    /// `LoomWatch`'s own address.
    #[must_use]
    pub fn base(&self) -> &str {
        &self.base
    }

    /// The client calls go out on: no proxy, no redirects followed.
    #[must_use]
    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    /// # Errors
    /// When `LoomWatch` can't be reached, or answers with an error or something that isn't JSON.
    pub async fn get_json(&self, path_and_query: &str) -> Result<Value> {
        let reply = self
            .send(Method::GET, path_and_query, None, Bytes::new())
            .await?;
        if !reply.status().is_success() {
            bail!("{path_and_query} answered {}", reply.status());
        }
        reply.json().await.context("LoomWatch's answer wasn't JSON")
    }

    /// Sends `body` as JSON, with `headers` such as a save's `If-Match`.
    ///
    /// # Errors
    /// When `LoomWatch` can't be reached. An error status is an answer, not an error.
    pub async fn send_json(
        &self,
        method: Method,
        path_and_query: &str,
        headers: &[(&'static str, String)],
        body: &Value,
    ) -> Result<reqwest::Response> {
        self.send_with(
            method,
            path_and_query,
            Some(HeaderValue::from_static("application/json")),
            headers,
            Bytes::from(body.to_string()),
        )
        .await
    }

    /// Sends one call as a local program does: no `Origin`, and the header `LoomWatch`'s own page
    /// sends on calls that change something.
    ///
    /// # Errors
    /// When `LoomWatch` can't be reached. An error status is an answer, not an error.
    pub async fn send(
        &self,
        method: Method,
        path_and_query: &str,
        content_type: Option<HeaderValue>,
        body: Bytes,
    ) -> Result<reqwest::Response> {
        self.send_with(method, path_and_query, content_type, &[], body)
            .await
    }

    async fn send_with(
        &self,
        method: Method,
        path_and_query: &str,
        content_type: Option<HeaderValue>,
        headers: &[(&'static str, String)],
        body: Bytes,
    ) -> Result<reqwest::Response> {
        let mut request = self
            .client
            .request(method, format!("{}{path_and_query}", self.base))
            .header("x-loomwatch-request", "1")
            .body(body);
        if let Some(content_type) = &content_type {
            request = request.header("content-type", content_type.as_bytes());
        }
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        Ok(request.send().await?)
    }
}
