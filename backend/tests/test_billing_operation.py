from services.billing_operation import model_billing_operation_key


def test_model_billing_operation_key_requires_a_reliable_scope():
    assert model_billing_operation_key(
        namespace="prompt-optimization",
        user_id="user-1",
        operation_scope="",
        material={"prompt": "same prompt"},
    ) is None


def test_model_billing_operation_key_is_replay_stable_but_input_sensitive():
    first = model_billing_operation_key(
        namespace="prompt-optimization",
        user_id="user-1",
        operation_scope="request-1",
        material={"prompt": "draw a city", "image": b"image"},
    )
    replay = model_billing_operation_key(
        namespace="prompt-optimization",
        user_id="user-1",
        operation_scope="request-1",
        material={"image": b"image", "prompt": "draw   a city"},
    )
    changed_request = model_billing_operation_key(
        namespace="prompt-optimization",
        user_id="user-1",
        operation_scope="request-1",
        material={"prompt": "draw a forest", "image": b"image"},
    )

    assert first == replay
    assert first
    assert changed_request != first
