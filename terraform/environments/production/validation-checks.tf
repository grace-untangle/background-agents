check "github_bot_configuration" {
  assert {
    condition = !var.enable_github_bot || (
      length(var.github_webhook_secret) > 0 &&
      length(var.github_bot_username) > 0
    )
    error_message = "When enable_github_bot is true, github_webhook_secret and github_bot_username must be non-empty."
  }
}

check "slack_bot_configuration" {
  assert {
    condition = !var.enable_slack_bot || (
      length(var.slack_bot_token) > 0 &&
      length(var.slack_signing_secret) > 0
    )
    error_message = "When enable_slack_bot is true, slack_bot_token and slack_signing_secret must be non-empty."
  }
}

check "linear_bot_configuration" {
  assert {
    condition = !var.enable_linear_bot || (
      length(var.linear_client_id) > 0 &&
      length(var.linear_client_secret) > 0 &&
      length(var.linear_webhook_secret) > 0
    )
    error_message = "When enable_linear_bot is true, linear_client_id, linear_client_secret, and linear_webhook_secret must be non-empty."
  }
}
