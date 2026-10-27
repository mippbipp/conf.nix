# opencode config for the Flake fixer's server, rendered to a read-only store
# path. Session rules from the Updater decide what the agent may do; the
# policies here are the hard floor that no session, project file or saved
# approval can lift.
{ model }:
let
  provider = builtins.head (builtins.split "/" model);
  deny = resource: {
    action = "tool.use";
    inherit resource;
    effect = "deny";
  };
in
{
  "$schema" = "https://opencode.ai/config.json";
  update = "disable";
  snapshots = false;
  default_agent = "flake-fixer";
  agents.flake-fixer = {
    description = "Repairs failed weekly flake updates for the Updater";
    mode = "primary";
    inherit model;
    permissions = [
      {
        action = "*";
        resource = "*";
        effect = "ask";
      }
    ];
  };
  policies = [
    # Only the pinned model's provider is usable, so a dead free model fails
    # loudly instead of falling back to a paid one.
    {
      action = "provider.use";
      resource = "*";
      effect = "deny";
    }
    {
      action = "provider.use";
      resource = provider;
      effect = "allow";
    }
    {
      action = "integration.use";
      resource = "mcp:*";
      effect = "deny";
    }
    {
      action = "integration.use";
      resource = "skill:*";
      effect = "deny";
    }
  ]
  ++ map deny [
    "webfetch:*"
    "websearch:*"
    "subagent:*"
    "question:*"
    "shell:* --impure*"
    "shell:git *"
    "shell:gh *"
    "shell:curl *"
    "shell:wget *"
    "shell:ssh *"
    "shell:scp *"
    "shell:sudo *"
    "shell:nix build *"
    "shell:nix run *"
    "shell:nix shell *"
    "shell:nix develop *"
    "shell:nix profile *"
    "shell:nix copy *"
    "shell:nix-shell *"
    # src/scope.ts holds the same paths.
    "edit:.github/*"
    "edit:secrets/*"
    "edit:.sops.yaml"
    "edit:checks.nix"
    "edit:hosts/pewter/flake-updater/*"
    "edit:*.git/*"
    "edit:*.opencode/*"
    "edit:*opencode.json*"
    "read:secrets/*"
  ];
}
