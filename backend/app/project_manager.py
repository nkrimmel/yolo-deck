import shutil
import time
from pathlib import Path
from git import Repo, InvalidGitRepositoryError
from .config import settings
from .models import ProjectInfo


class ProjectManager:
    def list_projects(self) -> list[ProjectInfo]:
        """Alle Projekte im projects/-Verzeichnis auflisten."""
        projects = []
        for item in sorted(settings.projects_dir.iterdir()):
            if item.is_dir() and not item.name.startswith("."):
                info = self._get_project_info(item)
                projects.append(info)
        return projects

    def add_project(self, path: str) -> ProjectInfo:
        """Projekt per absolutem Pfad hinzufügen (Symlink in projects/)."""
        source = Path(path).expanduser().resolve()
        if not source.is_dir():
            raise FileNotFoundError(f"Verzeichnis nicht gefunden: {path}")

        link = settings.projects_dir / source.name
        if link.exists():
            raise FileExistsError(f"Projekt '{source.name}' existiert bereits")

        settings.projects_dir.mkdir(parents=True, exist_ok=True)
        link.symlink_to(source)
        return self._get_project_info(link)

    def remove_project(self, project_id: str):
        """Projekt-Symlink entfernen (Original bleibt unberührt)."""
        link = settings.projects_dir / project_id
        if not link.exists():
            raise FileNotFoundError(f"Projekt '{project_id}' nicht gefunden")
        if link.is_symlink():
            link.unlink()
        else:
            raise FileNotFoundError("Nur Symlink-Projekte können entfernt werden")

    def get_project(self, project_id: str) -> ProjectInfo:
        """Einzelnes Projekt laden."""
        path = settings.projects_dir / project_id
        if not path.exists():
            raise FileNotFoundError(f"Projekt '{project_id}' nicht gefunden")
        return self._get_project_info(path)

    def prepare_workspace(self, project_id: str) -> Path:
        """
        Erstellt eine Arbeitskopie des Projekts für den Container.
        Verwendet git clone (lokal), damit das Original unberührt bleibt.
        Erstellt automatisch einen Feature-Branch für Claude.
        """
        source = settings.projects_dir / project_id
        if not source.exists():
            raise FileNotFoundError(f"Projekt '{project_id}' nicht gefunden")

        # Workspace-Verzeichnis: workspaces/<project_id>-<timestamp>
        timestamp = int(time.time())
        workspace = settings.workspaces_dir / f"{project_id}-{timestamp}"

        try:
            # Lokaler Git-Clone (schnell, hardlinks)
            Repo.clone_from(
                str(source),
                str(workspace),
                local=True,
                no_hardlinks=False,
            )
            repo = Repo(workspace)
            # Remote auf Original setzen
            repo.remotes.origin.set_url(str(source.resolve()))
            # Git-Config für Container (damit Claude committen kann)
            repo.config_writer().set_value("user", "name", "Claude YOLO").release()
            repo.config_writer().set_value("user", "email", "claude-yolo@localhost").release()
            # Feature-Branch erstellen
            branch_name = f"claude-yolo/{time.strftime('%Y%m%d-%H%M%S')}"
            repo.create_head(branch_name)
            repo.heads[branch_name].checkout()
        except InvalidGitRepositoryError:
            # Kein Git-Repo → einfache Kopie
            shutil.copytree(source, workspace)

        return workspace

    def sync_back(self, workspace: Path, project_id: str) -> str | None:
        """
        Committet uncommittete Änderungen und pusht den Branch
        zurück ins Original-Repo. Gibt den Branch-Namen zurück.
        """
        try:
            repo = Repo(workspace)
            branch = repo.active_branch.name

            # Uncommittete Änderungen committen
            if repo.is_dirty(untracked_files=True):
                repo.git.add("-A")
                repo.index.commit(f"claude-yolo: Änderungen auf {branch}")

            # Prüfen ob es neue Commits gibt (vs. origin)
            has_changes = False
            try:
                origin_branch = f"origin/{branch}"
                if origin_branch in [ref.name for ref in repo.refs]:
                    has_changes = list(repo.iter_commits(f"{origin_branch}..{branch}"))
                else:
                    # Branch existiert nicht im Origin → neue Commits vorhanden
                    has_changes = True
            except Exception:
                has_changes = True

            if has_changes:
                repo.remotes.origin.push(branch)
                return branch
        except Exception:
            pass
        return None

    def cleanup_workspace(self, workspace: Path):
        """Workspace-Kopie aufräumen."""
        if workspace.exists() and str(workspace).startswith(
            str(settings.workspaces_dir)
        ):
            shutil.rmtree(workspace)

    def _get_project_info(self, path: Path) -> ProjectInfo:
        info = ProjectInfo(id=path.name, name=path.name, path=str(path))
        try:
            repo = Repo(path)
            info.current_branch = str(repo.active_branch)
            if repo.head.is_valid():
                info.last_commit = repo.head.commit.message.strip()[:80]
        except (InvalidGitRepositoryError, TypeError, ValueError):
            pass
        return info
