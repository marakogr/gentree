//! Tool-calling payloads for the OpenAI-compatible transport.
//!
//! Contract: design.md §9, ADR-0012. The types here are the transport shape
//! only: what the model may call ([`ToolSpec`]), what it asked to call
//! ([`ToolCall`]) and what one non-streaming tool turn returned ([`ToolTurn`]).
//! The caller decides which tools exist and what a call means; this module
//! never executes anything.
//!
//! `ToolSpec` and `ToolCall` serialize exactly as the OpenAI wire format nests
//! them (`{type:"function", function:{...}}`), so [`ChatMessage`] carrying
//! assistant tool calls can be sent back unchanged.
//!
//! [`ChatMessage`]: crate::ChatMessage

use serde::de::{self, Deserializer};
use serde::ser::{SerializeStruct, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One function offered to the model.
///
/// `parameters` is a JSON Schema object (OpenAI's `function.parameters`). The
/// caller builds it from the same schemas the tools publish.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

impl ToolSpec {
    pub fn new(name: impl Into<String>, description: impl Into<String>, parameters: Value) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
        }
    }
}

impl Serialize for ToolSpec {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut root = serializer.serialize_struct("Tool", 2)?;
        root.serialize_field("type", "function")?;
        root.serialize_field(
            "function",
            &FunctionSpec {
                name: &self.name,
                description: &self.description,
                parameters: &self.parameters,
            },
        )?;
        root.end()
    }
}

#[derive(Serialize)]
struct FunctionSpec<'a> {
    name: &'a str,
    description: &'a str,
    parameters: &'a Value,
}

/// One function call requested by the model.
///
/// `arguments` stays the raw JSON string the provider sent: a broken payload is
/// reported to the model as a tool error instead of failing the whole turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

impl ToolCall {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        arguments: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            arguments: arguments.into(),
        }
    }

    /// Parses `arguments`; an empty string means "no arguments" (`{}`), which
    /// some local models emit for tools without parameters.
    pub fn arguments_json(&self) -> Result<Value, serde_json::Error> {
        if self.arguments.trim().is_empty() {
            return Ok(serde_json::json!({}));
        }
        serde_json::from_str(&self.arguments)
    }
}

impl Serialize for ToolCall {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("ToolCall", 3)?;
        state.serialize_field("id", &self.id)?;
        state.serialize_field("type", "function")?;
        state.serialize_field(
            "function",
            &FunctionCall {
                name: &self.name,
                arguments: &self.arguments,
            },
        )?;
        state.end()
    }
}

#[derive(Serialize)]
struct FunctionCall<'a> {
    name: &'a str,
    arguments: &'a str,
}

impl<'de> Deserialize<'de> for ToolCall {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct WireCall {
            #[serde(default)]
            id: String,
            #[serde(default, rename = "type")]
            kind: Option<String>,
            #[serde(default)]
            function: Option<WireFunction>,
        }

        #[derive(Deserialize)]
        struct WireFunction {
            #[serde(default)]
            name: String,
            #[serde(default)]
            arguments: String,
        }

        let call = WireCall::deserialize(deserializer)?;
        if call.id.trim().is_empty() {
            return Err(de::Error::custom("tool call has no id"));
        }
        if let Some(kind) = call.kind.as_deref() {
            if kind != "function" {
                return Err(de::Error::custom("tool call is not a function call"));
            }
        }
        let function = call
            .function
            .ok_or_else(|| de::Error::custom("tool call has no function"))?;
        if function.name.trim().is_empty() {
            return Err(de::Error::custom("tool call has no name"));
        }
        Ok(Self {
            id: call.id,
            name: function.name,
            arguments: function.arguments,
        })
    }
}

/// Outcome of one non-streaming tool turn.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolTurn {
    /// Assistant text, when the provider returned any next to the calls.
    pub content: Option<String>,
    /// Calls requested by the model; empty means the turn is final.
    pub tool_calls: Vec<ToolCall>,
    pub usage: Option<crate::ChatUsage>,
    /// Chain of thought, when the provider is a thinking model. DeepSeek
    /// requires it on every follow-up request that carries `tools`, so the
    /// caller replays it through [`ChatMessage::with_reasoning`].
    ///
    /// [`ChatMessage::with_reasoning`]: crate::ChatMessage::with_reasoning
    pub reasoning: Option<String>,
}
