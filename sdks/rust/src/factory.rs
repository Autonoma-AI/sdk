//! Factory definition helpers for hybrid entity creation.
//!
//! Users can register factories for models that have business logic (password
//! hashing, external service calls, etc.) while letting the SDK handle simpler
//! models via raw SQL.

use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use crate::errors::AutonomaError;
use crate::types::FactoryContext;

/// A convenience factory built from closures.
///
/// Use [`define_factory`] to construct one.
pub struct ClosureFactory {
    create_fn: Box<
        dyn for<'a> Fn(
                HashMap<String, Value>,
                &'a FactoryContext<'a>,
            )
                -> Pin<Box<dyn Future<Output = Result<HashMap<String, Value>, AutonomaError>> + Send + 'a>>
            + Send
            + Sync,
    >,
    teardown_fn: Option<
        Box<
            dyn for<'a> Fn(
                    &'a HashMap<String, Value>,
                    &'a FactoryContext<'a>,
                )
                    -> Pin<Box<dyn Future<Output = Result<(), AutonomaError>> + Send + 'a>>
                + Send
                + Sync,
        >,
    >,
}

#[async_trait]
impl crate::types::Factory for ClosureFactory {
    async fn create(
        &self,
        data: HashMap<String, Value>,
        ctx: &FactoryContext<'_>,
    ) -> Result<HashMap<String, Value>, AutonomaError> {
        (self.create_fn)(data, ctx).await
    }

    async fn teardown(
        &self,
        record: &HashMap<String, Value>,
        ctx: &FactoryContext<'_>,
    ) -> Result<(), AutonomaError> {
        match &self.teardown_fn {
            Some(f) => f(record, ctx).await,
            None => Err(AutonomaError {
                message: "no factory teardown".to_string(),
                code: "NO_FACTORY_TEARDOWN".to_string(),
                status: 500,
            }),
        }
    }

    fn has_teardown(&self) -> bool {
        self.teardown_fn.is_some()
    }
}

/// Define a factory from closures.
///
/// # Arguments
///
/// * `create` - Async closure that creates a single entity. Must return at least `{ pk_field: value }`.
/// * `teardown` - Optional async closure that tears down a single entity record.
///
/// # Example
///
/// ```ignore
/// let user_factory = define_factory(
///     |data, ctx| Box::pin(async move {
///         // custom creation logic
///         Ok(HashMap::from([("id".to_string(), Value::String("123".to_string()))]))
///     }),
///     None::<fn(&HashMap<String, Value>, &FactoryContext<'_>) -> Pin<Box<dyn Future<Output = Result<(), AutonomaError>> + Send + '_>>>,
/// );
/// ```
pub fn define_factory<C, T>(create: C, teardown: Option<T>) -> Box<dyn crate::types::Factory>
where
    C: for<'a> Fn(
            HashMap<String, Value>,
            &'a FactoryContext<'a>,
        )
            -> Pin<Box<dyn Future<Output = Result<HashMap<String, Value>, AutonomaError>> + Send + 'a>>
        + Send
        + Sync
        + 'static,
    T: for<'a> Fn(
            &'a HashMap<String, Value>,
            &'a FactoryContext<'a>,
        ) -> Pin<Box<dyn Future<Output = Result<(), AutonomaError>> + Send + 'a>>
        + Send
        + Sync
        + 'static,
{
    Box::new(ClosureFactory {
        create_fn: Box::new(create),
        teardown_fn: teardown.map(|f| {
            Box::new(f)
                as Box<
                    dyn for<'a> Fn(
                            &'a HashMap<String, Value>,
                            &'a FactoryContext<'a>,
                        )
                            -> Pin<Box<dyn Future<Output = Result<(), AutonomaError>> + Send + 'a>>
                        + Send
                        + Sync,
                >
        }),
    })
}
