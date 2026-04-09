//! Axum server adapter for the Autonoma SDK.
//!
//! Provides `create_axum_handler` to mount the Autonoma endpoint as an Axum route,
//! and `axum_handler` for standalone use.
//!
//! # Example
//! ```rust,ignore
//! use axum::{Router, routing::post};
//! use autonoma_sdk::axum::create_axum_handler;
//! use autonoma_sdk::types::HandlerConfig;
//!
//! #[tokio::main]
//! async fn main() {
//!     let config = todo!("build HandlerConfig");
//!     let app = Router::new()
//!         .route("/api/autonoma", post(create_axum_handler(config)));
//!     let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
//!     axum::serve(listener, app).await.unwrap();
//! }
//! ```

#[cfg(feature = "axum")]
mod inner {
    use axum::body::Bytes;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Json, Response};
    use std::sync::Arc;

    use crate::handler::handle_request;
    use crate::types::{HandlerConfig, HandlerRequest, SdkMeta};

    fn enrich_config(config: &mut HandlerConfig) {
        let sdk = config.sdk.get_or_insert(SdkMeta {
            orm: "unknown".to_string(),
            server: "unknown".to_string(),
        });
        sdk.server = "axum".to_string();
    }

    /// Create an Axum handler function for the Autonoma protocol.
    ///
    /// Returns an async handler suitable for use with `axum::routing::post(...)`.
    /// The config is wrapped in an `Arc` and shared across requests.
    pub fn create_axum_handler(
        mut config: HandlerConfig,
    ) -> impl Fn(HeaderMap, Bytes) -> std::pin::Pin<Box<dyn std::future::Future<Output = Response> + Send>>
           + Clone
           + Send
           + 'static {
        enrich_config(&mut config);
        let config = Arc::new(config);

        move |headers: HeaderMap, body: Bytes| {
            let config = Arc::clone(&config);
            Box::pin(async move {
                let body_str = String::from_utf8_lossy(&body).to_string();
                let header_map = headers
                    .iter()
                    .map(|(k, v)| {
                        (
                            k.as_str().to_lowercase(),
                            v.to_str().unwrap_or("").to_string(),
                        )
                    })
                    .collect();

                let handler_req = HandlerRequest {
                    body: body_str,
                    headers: header_map,
                };

                let result = handle_request(&config, &handler_req).await;
                let status =
                    StatusCode::from_u16(result.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                (status, Json(result.body)).into_response()
            })
        }
    }

    /// Standalone handler for custom Axum routing.
    ///
    /// Use this when you need more control over routing than `create_axum_handler` provides.
    pub async fn axum_handler(
        config: &HandlerConfig,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        let body_str = String::from_utf8_lossy(&body).to_string();
        let header_map = headers
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_lowercase(),
                    v.to_str().unwrap_or("").to_string(),
                )
            })
            .collect();

        let handler_req = HandlerRequest {
            body: body_str,
            headers: header_map,
        };

        let result = handle_request(config, &handler_req).await;
        let status =
            StatusCode::from_u16(result.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(result.body)).into_response()
    }
}

#[cfg(feature = "axum")]
pub use inner::*;
