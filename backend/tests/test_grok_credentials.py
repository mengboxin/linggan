from services.grok_credentials import build_runtime_models


def _catalog():
    return [
        {"id": "grok-4.3", "display_name": "Grok 4.3", "owned_by": "xai"},
        {"id": "grok-imagine-image-2.0", "display_name": "Grok Imagine Image 2.0", "owned_by": "xai"},
        {"id": "grok-video-1.5", "display_name": "Grok Video 1.5", "owned_by": "xai"},
        {"id": "grok-imagine-video-1.5", "display_name": "Legacy Grok Video", "owned_by": "xai"},
        {"id": "gpt-image-2", "display_name": "GPT Image 2", "owned_by": "openai"},
    ]


def test_runtime_catalog_splits_text_image_and_video_and_ignores_openai_models():
    public_models = build_runtime_models(
        _catalog(),
        api_base="https://foxapi.cn/v1",
        key_fingerprint="a" * 64,
    )

    llm_ids = [model["meta"]["model_name"] for model in public_models if model["category"] == "llm"]
    generate_ids = [model["meta"]["model_name"] for model in public_models if model["category"] == "generate"]
    video_ids = [model["meta"]["model_name"] for model in public_models if model["category"] == "video"]

    assert llm_ids == ["grok-4.3"]
    assert generate_ids == ["grok-imagine-image-2.0"]
    assert video_ids == ["grok-video-1.5"]
    image_model = next(model for model in public_models if model["category"] == "generate")
    reference_video = next(model for model in public_models if model["meta"]["model_name"] == "grok-video-1.5")
    assert image_model["is_featured"] is True
    assert reference_video["meta"]["requires_reference_image"] is True
    assert all(model["id"].startswith("grok:") for model in public_models)
    assert all(model["billing_mode"] == "grok_api_key" for model in public_models)


def test_runtime_catalog_recognizes_current_grok_media_model_ids():
    public_models = build_runtime_models(
        [
            {
                "id": "grok-imagine-image-2.0",
                "display_name": "Grok Imagine Image 2.0",
                "owned_by": "xai",
            },
            {
                "id": "grok-video-1.5",
                "display_name": "grok-video-1.5",
                "owned_by": "xai",
            },
        ],
        api_base="https://foxapi.cn/v1",
        key_fingerprint="a" * 64,
    )

    assert [(model["category"], model["meta"]["model_name"]) for model in public_models] == [
        ("generate", "grok-imagine-image-2.0"),
        ("video", "grok-video-1.5"),
    ]
