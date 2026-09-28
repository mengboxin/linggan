from services.grok_output import (
    grok_image_aspect_ratio,
    grok_image_resolution,
    grok_video_aspect_ratio,
    grok_video_duration,
    grok_video_requires_reference_image,
    grok_video_resolution,
)


def test_grok_image_aspect_ratio_aliases_unsupported_print_ratios():
    assert grok_image_aspect_ratio("4:5") == "3:4"
    assert grok_image_aspect_ratio("5:4") == "4:3"
    assert grok_image_aspect_ratio("16:9") == "16:9"
    assert grok_image_aspect_ratio(None, size="1024x1280") == "3:4"


def test_grok_image_resolution_clamps_4k_to_2k():
    assert grok_image_resolution("4k") == "2k"
    assert grok_image_resolution("2k") == "2k"
    assert grok_image_resolution(None, size="2880x2880") == "2k"
    assert grok_image_resolution(None, size="1024x1024") == "1k"


def test_grok_video_output_normalizes_duration_and_resolution():
    assert grok_video_aspect_ratio("9:16") == "9:16"
    assert grok_video_resolution("4k") == "1080p"
    assert grok_video_resolution("720") == "720p"
    assert grok_video_duration(0) == 1
    assert grok_video_duration(20) == 15
    assert grok_video_duration("8") == 8
    assert grok_video_requires_reference_image("grok-imagine-video-1.5") is True
    assert grok_video_requires_reference_image("grok-imagine-video") is True
