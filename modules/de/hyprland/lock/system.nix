_: {
  services = {
    # to make quickshell work
    logind.settings.Login = {
      HandleLidSwitch = "ignore";
      HandlePowerKeyLongPress = "poweroff";
      HandlePowerKey = "suspend";
    };
  };
}
