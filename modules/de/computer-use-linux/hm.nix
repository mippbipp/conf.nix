# computer-use-linux desktop bit: AT-SPI toolkit accessibility plus its
# opencode MCP entry.
# the bus comes from services.gnome.at-spi2-core.enable in the system module.
# doctor gates can_build_accessibility_tree on org.a11y.Status IsEnabled,
# which follows the dconf key below.
{ config, lib, ... }: {
  dconf.settings = {
    "org/gnome/desktop/interface" = {
      toolkit-accessibility = true;
    };
  };

  # Written verbatim under mcp.servers (V2 shape). NOT enableMcpIntegration:
  # its programs.mcp transform renders the pre-V2 mcp.<name> shape, which
  # opencode2 ignores.
  programs.opencode.settings.mcp.servers.computer-use-linux =
    lib.mkIf config.programs.opencode.enable
      {
        type = "local";
        command = [
          "computer-use-linux"
          "mcp"
        ];
      };
}
