{
  globals,
  host,
  config,
  ...
}:
let
  karakeep_port = "3000";
  tail_port = 3434;
  url = "https://${host}.${globals.tailnet.suffix}:${toString tail_port}";
in
{
  # AI tagging via free OpenRouter models. OPENAI_API_KEY in SOPS
  sops.secrets.karakeep_openrouter_env = {
    owner = "root";
    restartUnits = [
      "karakeep-web.service"
      "karakeep-workers.service"
    ];
  };

  services.karakeep = {
    enable = true;
    meilisearch.enable = true;
    browser.enable = true;
    environmentFile = config.sops.secrets.karakeep_openrouter_env.path;
    extraEnvironment = {
      PORT = karakeep_port;
      NEXTAUTH_URL = url;
      DISABLE_SIGNUPS = "true"; # disabled after first user signup
      DISABLE_NEW_RELEASE_CHECK = "true";
      OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
      # Models must support images AND response_format:json_schema.
      INFERENCE_TEXT_MODEL = "dots-studio/dots-3-note-preview:free";
      INFERENCE_IMAGE_MODEL = "dots-studio/dots-3-note-preview:free";
      INFERENCE_OUTPUT_SCHEMA = "structured";
      INFERENCE_ENABLE_AUTO_SUMMARIZATION = "false";
      EMBEDDING_ENABLE_AUTO_INDEXING = "false";
    };
  };

  # Exposed over tailnet HTTPS (generates the `karakeep-serve` unit).
  tailnetExpose.karakeep = {
    httpsPort = tail_port;
    backend = "http://127.0.0.1:${karakeep_port}";
    dependsOn = [ "karakeep-web.service" ]; # nixos service above
  };
}
