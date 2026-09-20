{ username, ... }: {
  # stack for input devices to DE
  services.libinput.enable = true;
  environment.etc."libinput/local-overrides.quirks".text = ''
    [Never Debounce]
    MatchUdevType=mouse
    ModelBouncingKeys=1
  '';

  # read permissions for /dev/input/*
  users.users."${username}".extraGroups = [ "input" ];
}
