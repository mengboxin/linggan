from dataclasses import dataclass

from services.agents.ppt_qa import normalize_pptx_qa_report


@dataclass
class _Issue:
    slide_num: int
    severity: str
    category: str
    message: str = "raw internal diagnostic"


class _Report:
    overall_score = 81
    passed = False
    slide_scores = {1: 100, 2: 62}
    issues = [
        _Issue(2, "ERROR", "shape_overlap"),
        _Issue(2, "WARNING", "text_overflow"),
    ]

    @property
    def errors(self):
        return [issue for issue in self.issues if issue.severity == "ERROR"]

    @property
    def warnings(self):
        return [issue for issue in self.issues if issue.severity == "WARNING"]

    @property
    def infos(self):
        return []


def test_pptx_qa_adapter_keeps_page_specific_user_safe_findings():
    summary = normalize_pptx_qa_report(_Report())

    assert summary["status"] == "completed"
    assert summary["overall_score"] == 81
    assert summary["requires_attention"] is True
    assert summary["summary"] == {"errors": 1, "warnings": 1, "info": 0}
    assert summary["pages"] == [{
        "page": 2,
        "score": 62,
        "issues": [
            {"severity": "ERROR", "category": "shape_overlap", "message": "页面元素发生非预期重叠，需要检查层级关系。"},
            {"severity": "WARNING", "category": "text_overflow", "message": "部分文字可能超出文本区域，需要检查可读性。"},
        ],
        "requires_attention": True,
    }]


def test_pptx_qa_adapter_ignores_only_svg_multiline_fragments_and_page_markers():
    class ConverterReport:
        overall_score = 50
        passed = False
        slide_scores = {1: 50}
        issues = [
            {
                "slide_num": 1,
                "severity": "WARNING",
                "category": "shape_overlap",
                "details": {
                    "shape_a": "TextBox 18",
                    "shape_b": "TextBox 19",
                    "text_a_preview": "一行文字的前半段",
                    "text_b_preview": "后一行文字",
                },
            },
            {
                "slide_num": 1,
                "severity": "ERROR",
                "category": "chart_legend_overflow",
                "message": "Legend/label '01 / 06' overflows content area RIGHT by 0.22\"",
            },
            {
                "slide_num": 1,
                "severity": "ERROR",
                "category": "peer_font_inconsistency",
                "details": {
                    "texts": {
                        "TextBox 4": "01",
                        "TextBox 24": "本页结论仍然保持可编辑。",
                        "TextBox 5": "01 / 06",
                    },
                },
            },
            {
                "slide_num": 1,
                "severity": "ERROR",
                "category": "text_overflow",
                "message": "real issue",
            },
        ]

        @property
        def errors(self):
            return [issue for issue in self.issues if issue["severity"] == "ERROR"]

        @property
        def warnings(self):
            return [issue for issue in self.issues if issue["severity"] == "WARNING"]

        @property
        def infos(self):
            return []

    summary = normalize_pptx_qa_report(ConverterReport())

    assert summary["overall_score"] == 80
    assert summary["passed"] is False
    assert summary["summary"] == {"errors": 1, "warnings": 0, "info": 0}
    assert summary["pages"] == [{
        "page": 1,
        "score": 80,
        "issues": [{"severity": "ERROR", "category": "text_overflow", "message": "部分文字可能超出文本区域，需要检查可读性。"}],
        "requires_attention": True,
    }]
