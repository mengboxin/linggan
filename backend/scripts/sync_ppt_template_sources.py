"""从 GitHub 归档同步经过审核且锁定版本的 PPT 模板。"""
from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath


BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
SOURCES_FILE = BACKEND_ROOT / "resources" / "ppt_templates" / "sources.json"
ALLOWED_LICENSES = {"Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0"}


def _members_by_suffix(package: zipfile.ZipFile) -> dict[str, str]:
    return {name.split("/", 1)[-1]: name for name in package.namelist() if "/" in name}


def _copy_member(package: zipfile.ZipFile, member: str, destination: Path, dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] {member} -> {destination}")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with package.open(member) as source, destination.open("wb") as target:
        shutil.copyfileobj(source, target)


def sync_source(source: dict, *, dry_run: bool) -> None:
    if str(source.get("kind") or "github").strip().lower() == "native":
        print(f"Skipping native source {source.get('id')}: maintained in the repository")
        return
    source_id = str(source.get("id") or "").strip()
    repo = str(source.get("repo") or "").strip()
    revision = str(source.get("revision") or "").strip()
    license_id = str(source.get("license") or "").strip()
    template_pattern = str(source.get("template_path") or "").strip()
    thumbnail_pattern = str(source.get("thumbnail_path") or "").strip()
    templates = [str(item).strip() for item in source.get("templates") or [] if str(item).strip()]
    if not source_id or not repo or len(revision) < 12 or not templates or "{template}" not in template_pattern or "{template}" not in thumbnail_pattern:
        raise ValueError(f"Invalid source manifest: {source_id or '<unknown>'}")
    if license_id not in ALLOWED_LICENSES:
        raise ValueError(f"License {license_id!r} is not approved for template redistribution")

    archive_url = f"https://codeload.github.com/{repo}/zip/{revision}"
    print(f"Fetching {repo}@{revision}")
    request = urllib.request.Request(archive_url, headers={"User-Agent": "PixelScribe-PPT-Template-Sync/1.0"})
    with tempfile.TemporaryDirectory(prefix="pixelscribe-ppt-templates-") as temp_dir:
        archive_path = Path(temp_dir) / f"{source_id}.zip"
        with urllib.request.urlopen(request, timeout=90) as response, archive_path.open("wb") as output:
            shutil.copyfileobj(response, output)
        with zipfile.ZipFile(archive_path) as package:
            members = _members_by_suffix(package)
            license_member = members.get("LICENSE")
            if not license_member:
                raise ValueError(f"{repo} archive has no root LICENSE")
            license_root = BACKEND_ROOT / "third_party_licenses" / source_id
            _copy_member(package, license_member, license_root / "LICENSE", dry_run)
            notice_member = members.get("NOTICE")
            if notice_member:
                _copy_member(package, notice_member, license_root / "NOTICE", dry_run)

            for template_name in templates:
                template_suffix = template_pattern.format(template=template_name).lstrip("/")
                thumbnail_suffix = thumbnail_pattern.format(template=template_name).lstrip("/")
                for suffix in (template_suffix, thumbnail_suffix):
                    path = PurePosixPath(suffix)
                    if path.is_absolute() or ".." in path.parts:
                        raise ValueError(f"Unsafe template path in source {source_id}: {suffix}")
                template_member = members.get(template_suffix)
                thumbnail_member = members.get(thumbnail_suffix)
                if not template_member or not thumbnail_member:
                    raise ValueError(f"Missing {template_name} template definition or thumbnail in {repo}")
                definition = json.loads(package.read(template_member))
                if not definition.get("id") or not isinstance(definition.get("layouts"), list) or not definition["layouts"]:
                    raise ValueError(f"Template {template_name} has no usable structured layouts")
                resource_dir = BACKEND_ROOT / "resources" / "ppt_templates" / source_id / template_name
                preview_path = REPO_ROOT / "frontend" / "public" / "ppt-templates" / f"{source_id}-{template_name}.png"
                _copy_member(package, template_member, resource_dir / "template.json", dry_run)
                _copy_member(package, thumbnail_member, preview_path, dry_run)
                print(f"  {template_name}: {len(definition['layouts'])} layouts")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", action="append", default=[], help="Only synchronize the named manifest source")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(SOURCES_FILE.read_text(encoding="utf-8"))
    sources = manifest.get("sources") if isinstance(manifest.get("sources"), list) else []
    selected = set(args.source)
    matched = 0
    for source in sources:
        if not isinstance(source, dict):
            continue
        if selected and source.get("id") not in selected:
            continue
        sync_source(source, dry_run=args.dry_run)
        matched += 1
    if selected and matched != len(selected):
        missing = sorted(selected - {str(source.get("id")) for source in sources if isinstance(source, dict)})
        raise SystemExit(f"Unknown source(s): {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
