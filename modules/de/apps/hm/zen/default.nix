# https://github.com/luisnquin/nixos-config/blob/main/home/modules/programs/browser/zen.nix
{
  inputs,
  ...
}:
{
  imports = [
    inputs.zen-browser.homeModules.beta
  ];
  programs.zen-browser = {
    enable = true;
    policies = import ./policies-config.nix;
    setAsDefaultBrowser = true;
  };

  home.sessionVariables = {
    # firefox
    MOZ_ENABLE_WAYLAND = 1;
    MOZ_DISABLE_RDD_SANDBOX = 1;
  };
}
