//! Named scenario abstraction (Scenario v2).
//!
//! A scenario's `up` is free-form async code (loops, conditionals, real API
//! calls) that provisions an isolated environment and returns the data a test
//! references. The optional `down` tears it back down. The idiomatic Rust
//! surface is the [`Scenario`] trait; [`define_scenario`] /
//! [`define_scenario_up_only`] wrap closures into a registered scenario so a
//! host can register one inline without declaring a struct.

use async_trait::async_trait;
use std::future::Future;
use std::pin::Pin;

use crate::errors::AutonomaError;
use crate::types::{ScenarioDownContext, ScenarioUpContext, ScenarioUpResult};

/// A named scenario. Implement `up` to provision an isolated environment and
/// return the data a test references; the default `down` is a no-op teardown.
/// Register scenarios on `HandlerConfig.scenarios`.
#[async_trait]
pub trait Scenario: Send + Sync {
    /// The stable identifier the platform calls `up`/`down` by.
    fn name(&self) -> &str;

    /// The human-readable summary shown in `discover`.
    fn description(&self) -> &str;

    /// Runs free-form provisioning and returns the environment.
    async fn up(&self, ctx: &ScenarioUpContext) -> Result<ScenarioUpResult, AutonomaError>;

    /// Tears the environment back down. A nil override is a no-op.
    async fn down(&self, ctx: &ScenarioDownContext) -> Result<(), AutonomaError> {
        let _ = ctx;
        Ok(())
    }
}

/// A registered scenario: a boxed [`Scenario`] the handler stores and
/// dispatches to by name.
pub type ScenarioRegistration = Box<dyn Scenario>;

type UpFn = Box<
    dyn for<'a> Fn(
            &'a ScenarioUpContext,
        )
            -> Pin<Box<dyn Future<Output = Result<ScenarioUpResult, AutonomaError>> + Send + 'a>>
        + Send
        + Sync,
>;

type DownFn = Box<
    dyn for<'a> Fn(
            &'a ScenarioDownContext,
        ) -> Pin<Box<dyn Future<Output = Result<(), AutonomaError>> + Send + 'a>>
        + Send
        + Sync,
>;

/// A closure-backed [`Scenario`]. Built by [`define_scenario`] /
/// [`define_scenario_up_only`]; not usually constructed directly.
pub struct FnScenario {
    name: String,
    description: String,
    up: UpFn,
    down: Option<DownFn>,
}

#[async_trait]
impl Scenario for FnScenario {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        &self.description
    }

    async fn up(&self, ctx: &ScenarioUpContext) -> Result<ScenarioUpResult, AutonomaError> {
        (self.up)(ctx).await
    }

    async fn down(&self, ctx: &ScenarioDownContext) -> Result<(), AutonomaError> {
        match &self.down {
            Some(down) => down(ctx).await,
            None => Ok(()),
        }
    }
}

/// Register a scenario with both an `up` and a `down`. Panics on an empty name,
/// since an invalid scenario is a programming error caught at process start.
pub fn define_scenario<U, D>(
    name: impl Into<String>,
    description: impl Into<String>,
    up: U,
    down: Option<D>,
) -> Box<dyn Scenario>
where
    U: for<'a> Fn(
            &'a ScenarioUpContext,
        )
            -> Pin<Box<dyn Future<Output = Result<ScenarioUpResult, AutonomaError>> + Send + 'a>>
        + Send
        + Sync
        + 'static,
    D: for<'a> Fn(
            &'a ScenarioDownContext,
        ) -> Pin<Box<dyn Future<Output = Result<(), AutonomaError>> + Send + 'a>>
        + Send
        + Sync
        + 'static,
{
    let name = name.into();
    assert!(
        !name.is_empty(),
        "autonoma: scenario name must be a non-empty string"
    );
    Box::new(FnScenario {
        name,
        description: description.into(),
        up: Box::new(up),
        down: down.map(|d| Box::new(d) as DownFn),
    })
}

/// Register a scenario with no `down` (a no-op teardown).
pub fn define_scenario_up_only<U>(
    name: impl Into<String>,
    description: impl Into<String>,
    up: U,
) -> Box<dyn Scenario>
where
    U: for<'a> Fn(
            &'a ScenarioUpContext,
        )
            -> Pin<Box<dyn Future<Output = Result<ScenarioUpResult, AutonomaError>> + Send + 'a>>
        + Send
        + Sync
        + 'static,
{
    let name = name.into();
    assert!(
        !name.is_empty(),
        "autonoma: scenario name must be a non-empty string"
    );
    Box::new(FnScenario {
        name,
        description: description.into(),
        up: Box::new(up),
        down: None,
    })
}
