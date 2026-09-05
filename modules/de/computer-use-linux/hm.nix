# computer-use-linux desktop bit: AT-SPI toolkit accessibility plus the
# opencode MCP wiring. Gram-only: the binary lives in gram's systemPackages.
# (The bus itself comes from services.gnome.at-spi2-core.enable in the
# system module.)
# doctor gates can_build_accessibility_tree on org.a11y.Status IsEnabled,
# which follows the dconf key below.
{
  inputs,
  pkgs,
  ...
}:
{
  dconf.settings = {
    "org/gnome/desktop/interface" = {
      toolkit-accessibility = true;
    };
  };

  programs.opencode = {
    enable = true;
    # Binary stays on the llm-agents input (fast updates); HM pins the same
    # derivation so there is exactly one opencode2 provenance.
    package = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.opencode2;
    # Written verbatim under mcp.servers (V2 shape). NOT enableMcpIntegration:
    # its programs.mcp transform renders the pre-V2 mcp.<name> shape, which
    # opencode2 ignores.
    settings.mcp.servers.computer-use-linux = {
      type = "local";
      command = [
        "computer-use-linux"
        "mcp"
      ];
    };
  };
}
