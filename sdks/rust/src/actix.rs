//! Actix Web server adapter for the Autonoma SDK.
//!
//! Provides `create_actix_handler` to mount the Autonoma endpoint as an Actix Web resource,
//! and `actix_handler` for standalone use with custom routing.

#[cfg(feature = "actix")]
mod inner {
    use actix_web::{web, HttpRequest, HttpResponse};
    use std::sync::Arc;

    use crate::handler::handle_request;
    use crate::types::{HandlerConfig, HandlerRequest, SdkMeta};

    fn enrich_config(config: &mut HandlerConfig) {
        let sdk = config.sdk.get_or_insert(SdkMeta {
            orm: "unknown".to_string(),
            server: "unknown".to_string(),
        });
        sdk.server = "actix".to_string();
    }

    /// Create an Actix Web handler function for the Autonoma protocol.
    ///
    /// Returns an async handler suitable for use with `web::resource().route(web::post().to(...))`.
    /// The config is wrapped in an `Arc` and shared across requests.
    pub fn create_actix_handler(
        mut config: HandlerConfig,
    ) -> impl Fn(HttpRequest, web::Bytes) -> std::pin::Pin<Box<dyn std::future::Future<Output = HttpResponse>>>
           + Clone
           + 'static {
        enrich_config(&mut config);
        let config = Arc::new(config);

        move |req: HttpRequest, body: web::Bytes| {
            let config = Arc::clone(&config);
            Box::pin(async move {
                let body_str = String::from_utf8_lossy(&body).to_string();
                let headers = req
                    .headers()
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
                    headers,
                };

                let result = handle_request(&config, &handler_req).await;
                HttpResponse::build(
                    actix_web::http::StatusCode::from_u16(result.status).unwrap_or(
                        actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                    ),
                )
                .json(result.body)
            })
        }
    }

    /// Standalone handler for custom Actix Web routing.
    pub async fn actix_handler(
        config: &HandlerConfig,
        req: HttpRequest,
        body: web::Bytes,
    ) -> HttpResponse {
        let body_str = String::from_utf8_lossy(&body).to_string();
        let headers = req
            .headers()
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
            headers,
        };

        let result = handle_request(config, &handler_req).await;
        HttpResponse::build(
            actix_web::http::StatusCode::from_u16(result.status)
                .unwrap_or(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(result.body)
    }
}

#[cfg(feature = "actix")]
pub use inner::*;
