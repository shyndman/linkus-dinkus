# The Model

All application LLM calls use `LLM_PROVIDER_URL`, `LLM_PROVIDER_API_TOKEN`, `LLM_PROVIDER_MODEL_PROVIDER`, and `LLM_PROVIDER_MODEL_ID`. The URL is the gateway root, such as `https://host/`. Direct AI SDK calls use its `/v1` API; agent calls use `pi-native` transport with the provider's client catalog metadata.

