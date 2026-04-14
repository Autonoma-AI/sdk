require "rails"
require "active_record/railtie"
require "action_controller/railtie"

module AutonomaExample
  class Application < Rails::Application
    config.load_defaults 7.1
    config.api_only = true
  end
end
