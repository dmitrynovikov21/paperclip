//! Runner-owned provider admission metadata. These capabilities are selected
//! only after the descriptor's pinned profile and launch authority validate;
//! they cannot be enabled by a sidecar event or a caller-supplied flag.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunAttachmentPolicy {
    ImmutableInstructions,
    AuthenticatedRunGrants,
}

pub(crate) fn run_attachment_policy(agent: &str) -> RunAttachmentPolicy {
    match agent {
        "cursor" => RunAttachmentPolicy::AuthenticatedRunGrants,
        _ => RunAttachmentPolicy::ImmutableInstructions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_qualified_providers_opt_into_run_grant_rotation() {
        assert_eq!(
            run_attachment_policy("cursor"),
            RunAttachmentPolicy::AuthenticatedRunGrants
        );
        for agent in ["claude", "codex", "grok", "pi", "copilot", "unknown"] {
            assert_eq!(
                run_attachment_policy(agent),
                RunAttachmentPolicy::ImmutableInstructions
            );
        }
    }
}
