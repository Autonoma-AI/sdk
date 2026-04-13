Rails.application.routes.draw do
  post "/api/autonoma", to: "autonoma#handle"
end
