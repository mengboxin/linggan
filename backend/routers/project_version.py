"""
项目版本控制路由
支持项目历史记录、版本管理、差异对比等功能
"""
import json
import hashlib
import uuid
from datetime import datetime
from typing import List, Dict, Optional, Any, Tuple
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, BackgroundTasks
from pydantic import BaseModel, Field
import repositories.task_repo as task_repo
from core.config import settings

router = APIRouter(prefix="/api/project-versions", tags=["项目版本控制"])

# ─── 数据模型 ─────────────────────────────────────────────────────────────

class ProjectInfo(BaseModel):
    id: str
    name: str
    created_at: datetime
    updated_at: datetime
    file_size: int
    version_count: int
    last_modified_by: str
    description: Optional[str] = None

class ProjectVersion(BaseModel):
    id: str
    project_id: str
    version: int
    name: str
    created_at: datetime
    created_by: str
    data_hash: str
    data_size: int
    metadata: Dict[str, Any] = {}
    changes: Optional[List[Dict[str, Any]]] = None
    is_snapshot: bool = False  # 是否完整快照
    diff_from: Optional[int] = None  # 与哪个版本有差异

class ProjectHistory(BaseModel):
    project_id: str
    versions: List[ProjectVersion]
    current_version: int
    total_size: int

class DiffResult(BaseModel):
    added: List[str]  # 新增的图层
    removed: List[str]  # 删除的图层
    modified: List[Dict[str, Any]]  # 修改的图层
    renamed: List[Dict[str, Any]]  # 重命名的图层
    stats: Dict[str, Any]  # 统计信息

# ─── 版本控制管理器 ──────────────────────────────────────────────────────

class VersionControlManager:
    def __init__(self, storage_path: str = "./project_versions"):
        self.storage_path = Path(storage_path)
        self.storage_path.mkdir(exist_ok=True)
        self.projects: Dict[str, ProjectInfo] = {}
        self.versions: Dict[str, List[ProjectVersion]] = {}
        self.max_versions = 50  # 最大版本数

    def _calculate_hash(self, data: Dict[str, Any]) -> str:
        """计算数据哈希值"""
        json_str = json.dumps(data, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(json_str.encode()).hexdigest()

    def _save_version_data(self, version: ProjectVersion, data: Dict[str, Any]):
        """保存版本数据到文件"""
        version_file = self.storage_path / f"v_{version.id}.json"
        with open(version_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def _load_version_data(self, version: ProjectVersion) -> Dict[str, Any]:
        """加载版本数据"""
        version_file = self.storage_path / f"v_{version.id}.json"
        with open(version_file, 'r', encoding='utf-8') as f:
            return json.load(f)

    def create_project(self, project_id: str, name: str, user_id: str,
                      data: Dict[str, Any], description: Optional[str] = None) -> ProjectVersion:
        """创建项目并初始化第一个版本"""
        project = ProjectInfo(
            id=project_id,
            name=name,
            created_at=datetime.now(),
            updated_at=datetime.now(),
            file_size=len(json.dumps(data, ensure_ascii=False).encode()),
            version_count=1,
            last_modified_by=user_id,
            description=description
        )
        self.projects[project_id] = project
        self.versions[project_id] = []

        # 创建初始版本
        initial_version = self._create_version(
            project_id=project_id,
            version=1,
            name="初始版本",
            user_id=user_id,
            data=data,
            is_snapshot=True
        )

        return initial_version

    def _create_version(self, project_id: str, version: int, name: str,
                        user_id: str, data: Dict[str, Any],
                        is_snapshot: bool = False, diff_from: Optional[int] = None) -> ProjectVersion:
        """创建新版本"""
        data_hash = self._calculate_hash(data)
        data_size = len(json.dumps(data, ensure_ascii=False).encode())

        version_obj = ProjectVersion(
            id=str(uuid.uuid4()),
            project_id=project_id,
            version=version,
            name=name,
            created_at=datetime.now(),
            created_by=user_id,
            data_hash=data_hash,
            data_size=data_size,
            metadata={
                "layer_count": len(data.get("layers", [])),
                "canvas_size": data.get("canvasImage", "")[:50] + "..." if data.get("canvasImage") else None
            },
            is_snapshot=is_snapshot,
            diff_from=diff_from
        )

        # 保存版本数据
        self._save_version_data(version_obj, data)

        # 添加到版本列表
        if project_id not in self.versions:
            self.versions[project_id] = []

        self.versions[project_id].append(version_obj)

        # 保持最大版本数限制
        if len(self.versions[project_id]) > self.max_versions:
            old_versions = self.versions[project_id][:len(self.versions[project_id]) - self.max_versions]
            for old_version in old_versions:
                # 删除旧版本文件
                version_file = self.storage_path / f"v_{old_version.id}.json"
                if version_file.exists():
                    version_file.unlink()
            self.versions[project_id] = self.versions[project_id][-self.max_versions:]

        # 更新项目信息
        if project_id in self.projects:
            self.projects[project_id].version_count = len(self.versions[project_id])
            self.projects[project_id].updated_at = datetime.now()
            self.projects[project_id].last_modified_by = user_id

        return version_obj

    def add_version(self, project_id: str, name: str, user_id: str,
                   data: Dict[str, Any], auto_save: bool = False) -> ProjectVersion:
        """添加新版本"""
        if project_id not in self.projects:
            raise ValueError("项目不存在")

        # 获取当前版本号
        current_versions = self.versions[project_id]
        next_version = current_versions[-1].version + 1 if current_versions else 1

        # 计算与上一个版本的差异
        last_version = current_versions[-1] if current_versions else None
        diff_from = last_version.version if last_version else None

        # 如果开启自动保存，且变化不大，只保存差异
        if auto_save and last_version:
            diff = self.calculate_diff(last_version, data)
            if diff.get("stats", {}).get("change_ratio", 0) < 0.1:  # 变化小于10%
                # 创建增量版本
                version = self._create_version(
                    project_id=project_id,
                    version=next_version,
                    name=name,
                    user_id=user_id,
                    data=data,
                    is_snapshot=False,
                    diff_from=diff_from
                )
                # 存储差异信息
                version.changes = diff
                return version

        # 创建完整版本
        version = self._create_version(
            project_id=project_id,
            version=next_version,
            name=name,
            user_id=user_id,
            data=data,
            is_snapshot=True,
            diff_from=diff_from
        )

        return version

    def get_version(self, project_id: str, version_id: str) -> Optional[ProjectVersion]:
        """获取指定版本"""
        if project_id not in self.versions:
            return None
        return next((v for v in self.versions[project_id] if v.id == version_id), None)

    def get_latest_version(self, project_id: str) -> Optional[ProjectVersion]:
        """获取最新版本"""
        if project_id not in self.versions or not self.versions[project_id]:
            return None
        return self.versions[project_id][-1]

    def get_version_history(self, project_id: str) -> ProjectHistory:
        """获取版本历史"""
        if project_id not in self.versions:
            raise ValueError("项目不存在")

        versions = self.versions[project_id]
        current_version = versions[-1].version if versions else 0

        total_size = sum(v.data_size for v in versions)

        return ProjectHistory(
            project_id=project_id,
            versions=versions,
            current_version=current_version,
            total_size=total_size
        )

    def calculate_diff(self, version: ProjectVersion, new_data: Dict[str, Any]) -> DiffResult:
        """计算版本差异"""
        old_data = self._load_version_data(version)
        old_layers = old_data.get("layers", [])
        new_layers = new_data.get("layers", [])

        # 构建图层映射
        old_layer_map = {layer["id"]: layer for layer in old_layers}
        new_layer_map = {layer["id"]: layer for layer in new_layers}

        # 查找差异
        added = []
        removed = []
        modified = []
        renamed = []

        # 检查新增的图层
        for layer_id, new_layer in new_layer_map.items():
            if layer_id not in old_layer_map:
                added.append(layer_id)

        # 检查删除的图层
        for layer_id, old_layer in old_layer_map.items():
            if layer_id not in new_layer_map:
                removed.append(layer_id)

        # 检查修改的图层
        for layer_id, new_layer in new_layer_map.items():
            if layer_id in old_layer_map:
                old_layer = old_layer_map[layer_id]
                if old_layer != new_layer:
                    # 检查是否只是重命名
                    if old_layer["imageBase64"] == new_layer["imageBase64"] and old_layer["opacity"] == new_layer["opacity"]:
                        renamed.append({
                            "id": layer_id,
                            "old_name": old_layer["name"],
                            "new_name": new_layer["name"]
                        })
                    else:
                        modified.append({
                            "id": layer_id,
                            "changes": self._get_layer_changes(old_layer, new_layer)
                        })

        # 计算统计信息
        total_changes = len(added) + len(removed) + len(modified)
        change_ratio = total_changes / max(len(old_layers), len(new_layers), 1)

        return DiffResult(
            added=added,
            removed=removed,
            modified=modified,
            renamed=renamed,
            stats={
                "total_changes": total_changes,
                "change_ratio": change_ratio,
                "old_layer_count": len(old_layers),
                "new_layer_count": len(new_layers),
                "added_count": len(added),
                "removed_count": len(removed),
                "modified_count": len(modified),
                "renamed_count": len(renamed)
            }
        )

    def _get_layer_changes(self, old_layer: Dict[str, Any], new_layer: Dict[str, Any]) -> Dict[str, Any]:
        """获取图层的具体变化"""
        changes = {}
        for key in old_layer:
            if key in new_layer and old_layer[key] != new_layer[key]:
                changes[key] = {
                    "old": old_layer[key],
                    "new": new_layer[key]
                }
        return changes

    def restore_version(self, project_id: str, version_id: str, user_id: str) -> ProjectVersion:
        """恢复到指定版本"""
        version = self.get_version(project_id, version_id)
        if not version:
            raise ValueError("版本不存在")

        # 创建一个恢复版本
        version_data = self._load_version_data(version)
        restore_name = f"恢复到 v{version.version}"

        restored_version = self._create_version(
            project_id=project_id,
            version=version.version + 1,
            name=restore_name,
            user_id=user_id,
            data=version_data,
            is_snapshot=True,
            diff_from=version.version
        )

        return restored_version

    def create_branch(self, project_id: str, version_id: str, branch_name: str, user_id: str) -> str:
        """创建分支"""
        version = self.get_version(project_id, version_id)
        if not version:
            raise ValueError("版本不存在")

        # 创建新分支的项目
        branch_project_id = f"{project_id}_{branch_name}"
        branch_version = self._create_version(
            project_id=branch_project_id,
            version=1,
            name=branch_name,
            user_id=user_id,
            data=self._load_version_data(version)
        )

        return branch_project_id

    def merge_branch(self, source_project_id: str, target_project_id: str, user_id: str) -> ProjectVersion:
        """合并分支"""
        if source_project_id not in self.versions or target_project_id not in self.versions:
            raise ValueError("项目不存在")

        source_versions = self.versions[source_project_id]
        target_versions = self.versions[target_project_id]

        # 获取最新版本
        latest_source = source_versions[-1]
        latest_target = target_versions[-1]

        # 合并数据
        source_data = self._load_version_data(latest_source)
        target_data = self._load_version_data(latest_target)

        # 这里可以实现更复杂的合并逻辑
        # 简单示例：使用源项目的数据
        merged_version = self._create_version(
            project_id=target_project_id,
            version=latest_target.version + 1,
            name=f"合并 {source_project_id}",
            user_id=user_id,
            data=source_data,
            is_snapshot=True,
            diff_from=latest_target.version
        )

        return merged_version

    def cleanup_old_versions(self, project_id: str, keep_count: int = 10):
        """清理旧版本，保留最近的几个版本"""
        if project_id not in self.versions:
            return

        versions = self.versions[project_id]
        if len(versions) <= keep_count:
            return

        # 保留最近的版本
        to_keep = versions[-keep_count:]
        to_remove = versions[:-keep_count]

        # 删除旧版本文件
        for version in to_remove:
            version_file = self.storage_path / f"v_{version.id}.json"
            if version_file.exists():
                version_file.unlink()

        # 更新版本列表
        self.versions[project_id] = to_keep

        # 更新项目信息
        if project_id in self.projects:
            self.projects[project_id].version_count = len(to_keep)

# 全局版本控制管理器
version_manager = VersionControlManager()

# ─── 路由 ──────────────────────────────────────────────────────────────────

class CreateProjectRequest(BaseModel):
    name: str
    user_id: str
    data: Dict[str, Any]
    description: Optional[str] = None

@router.post("/projects")
async def create_project(body: CreateProjectRequest):
    """创建新项目"""
    project_id = str(uuid.uuid4())
    version = version_manager.create_project(
        project_id=project_id,
        name=body.name,
        user_id=body.user_id,
        data=body.data,
        description=body.description
    )
    return {
        "project_id": project_id,
        "version_id": version.id,
        "version": version.version
    }

@router.get("/projects/{project_id}")
async def get_project_info(project_id: str):
    """获取项目信息"""
    if project_id not in version_manager.projects:
        raise HTTPException(404, "项目不存在")

    project = version_manager.projects[project_id]
    return project

@router.get("/projects/{project_id}/history")
async def get_project_history(project_id: str):
    """获取项目版本历史"""
    try:
        history = version_manager.get_version_history(project_id)
        return history
    except ValueError as e:
        raise HTTPException(404, str(e))

@router.get("/projects/{project_id}/versions")
async def get_project_versions(project_id: str):
    """获取项目的所有版本"""
    if project_id not in version_manager.versions:
        raise HTTPException(404, "项目不存在")

    versions = version_manager.versions[project_id]
    return {
        "project_id": project_id,
        "versions": versions,
        "total": len(versions)
    }

@router.get("/projects/{project_id}/versions/{version_id}")
async def get_project_version(project_id: str, version_id: str):
    """获取指定版本的数据"""
    version = version_manager.get_version(project_id, version_id)
    if not version:
        raise HTTPException(404, "版本不存在")

    data = version_manager._load_version_data(version)
    return {
        "version": version,
        "data": data
    }

@router.post("/projects/{project_id}/versions")
async def add_project_version(
    project_id: str,
    name: str,
    user_id: str,
    data: Dict[str, Any],
    auto_save: bool = False,
):
    """添加新版本"""
    if project_id not in version_manager.projects:
        raise HTTPException(404, "项目不存在")

    version = version_manager.add_version(
        project_id=project_id,
        name=name,
        user_id=user_id,
        data=data,
        auto_save=auto_save
    )
    return {
        "version_id": version.id,
        "version": version.version,
        "created_at": version.created_at
    }

@router.get("/projects/{project_id}/versions/{version_id}/diff")
async def get_version_diff(
    project_id: str,
    version_id: str,
    compare_to: Optional[str] = None,
):
    """获取版本差异"""
    version = version_manager.get_version(project_id, version_id)
    if not version:
        raise HTTPException(404, "版本不存在")

    current_data = version_manager._load_version_data(version)

    if compare_to:
        compare_version = version_manager.get_version(project_id, compare_to)
        if not compare_version:
            raise HTTPException(404, "对比版本不存在")

        compare_data = version_manager._load_version_data(compare_version)
        # 这里需要实现比较逻辑
        diff = {"message": "差比较功能待实现"}
    else:
        # 与上一个版本比较
        history = version_manager.get_version_history(project_id)
        if len(history.versions) > 1 and history.versions[-2].id != version.id:
            compare_version = history.versions[-2]
            compare_data = version_manager._load_version_data(compare_version)
            diff = version_manager.calculate_diff(compare_version, current_data)
        else:
            diff = {"message": "没有可对比的版本"}

    return {
        "diff": diff,
        "version": version
    }

@router.post("/projects/{project_id}/restore")
async def restore_version(
    project_id: str,
    version_id: str,
    user_id: str,
):
    """恢复到指定版本"""
    try:
        restored_version = version_manager.restore_version(
            project_id=project_id,
            version_id=version_id,
            user_id=user_id
        )
        return {
            "restored_version": restored_version.id,
            "message": f"已恢复到版本 {restored_version.version}"
        }
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.post("/projects/{project_id}/branch")
async def create_project_branch(
    project_id: str,
    version_id: str,
    branch_name: str,
    user_id: str,
):
    """创建项目分支"""
    try:
        branch_project_id = version_manager.create_branch(
            project_id=project_id,
            version_id=version_id,
            branch_name=branch_name,
            user_id=user_id
        )
        return {
            "branch_project_id": branch_project_id,
            "message": f"成功创建分支 {branch_name}"
        }
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.post("/projects/{source_project_id}/merge/{target_project_id}")
async def merge_project_branch(
    source_project_id: str,
    target_project_id: str,
    user_id: str,
):
    """合并项目分支"""
    try:
        merged_version = version_manager.merge_branch(
            source_project_id=source_project_id,
            target_project_id=target_project_id,
            user_id=user_id
        )
        return {
            "merged_version": merged_version.id,
            "message": f"已合并分支到版本 {merged_version.version}"
        }
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.delete("/projects/{project_id}/versions")
async def cleanup_project_versions(
    project_id: str,
    keep_count: int = 10,
):
    """清理项目旧版本"""
    version_manager.cleanup_old_versions(project_id, keep_count)
    return {"message": f"已清理旧版本，保留最近的 {keep_count} 个版本"}

@router.get("/stats")
async def get_version_stats():
    """获取版本控制统计信息"""
    total_projects = len(version_manager.projects)
    total_versions = sum(len(versions) for versions in version_manager.versions.values())

    total_size = 0
    for versions in version_manager.versions.values():
        total_size += sum(v.data_size for v in versions)

    return {
        "total_projects": total_projects,
        "total_versions": total_versions,
        "total_storage": total_size,
        "average_versions_per_project": total_versions / total_projects if total_projects > 0 else 0,
        "max_versions_per_project": max(len(versions) for versions in version_manager.versions.values()) if version_manager.versions else 0
    }