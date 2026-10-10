import type { SQLiteDatabase } from 'expo-sqlite';
import type { Project, ProjectDraft, ProjectScreen } from '../types/project';

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface ScreenRow {
  id: string;
  project_id: string;
  name: string;
  position: number;
  created_at: string;
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function requireName(name: string, label: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw new Error(`${label}: укажите название.`);
  }
  return normalized;
}

export async function initializeProjectDatabase(
  db: SQLiteDatabase,
): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON;');
  const version = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version;',
  );

  if ((version?.user_version ?? 0) < 1) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_screens (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS project_screens_project_position
          ON project_screens(project_id, position);

        PRAGMA user_version = 1;
      `);
    });
  }
}

function buildProjects(
  projectRows: ProjectRow[],
  screenRows: ScreenRow[],
): Project[] {
  const screensByProject = new Map<string, ProjectScreen[]>();
  for (const row of screenRows) {
    const projectScreens = screensByProject.get(row.project_id) ?? [];
    projectScreens.push({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      position: row.position,
      createdAt: row.created_at,
    });
    screensByProject.set(row.project_id, projectScreens);
  }

  return projectRows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    screens: screensByProject.get(row.id) ?? [],
  }));
}

export async function listProjects(db: SQLiteDatabase): Promise<Project[]> {
  const [projectRows, screenRows] = await Promise.all([
    db.getAllAsync<ProjectRow>(
      'SELECT id, name, description, created_at, updated_at FROM projects ORDER BY updated_at DESC;',
    ),
    db.getAllAsync<ScreenRow>(
      'SELECT id, project_id, name, position, created_at FROM project_screens ORDER BY project_id, position, created_at;',
    ),
  ]);
  return buildProjects(projectRows, screenRows);
}

export async function createProject(
  db: SQLiteDatabase,
  draft: ProjectDraft,
): Promise<Project> {
  const now = new Date().toISOString();
  const id = makeId();
  const screenId = makeId();
  const project: Project = {
    id,
    name: requireName(draft.name, 'Проект'),
    description: draft.description.trim(),
    createdAt: now,
    updatedAt: now,
    screens: [
      {
        id: screenId,
        projectId: id,
        name: 'Экран 1',
        position: 0,
        createdAt: now,
      },
    ],
  };

  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      'INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?);',
      project.id,
      project.name,
      project.description,
      project.createdAt,
      project.updatedAt,
    );
    await transaction.runAsync(
      'INSERT INTO project_screens (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?);',
      screenId,
      id,
      'Экран 1',
      0,
      now,
    );
  });

  return project;
}

export async function duplicateProject(
  db: SQLiteDatabase,
  projectId: string,
): Promise<Project> {
  const projects = await listProjects(db);
  const source = projects.find((project) => project.id === projectId);
  if (!source) throw new Error('Не удалось найти проект для копирования.');

  const now = new Date().toISOString();
  const duplicateId = makeId();
  const duplicate: Project = {
    ...source,
    id: duplicateId,
    name: `${source.name} (копия)`,
    createdAt: now,
    updatedAt: now,
    screens: source.screens.map((screen) => ({
      ...screen,
      id: makeId(),
      projectId: duplicateId,
      createdAt: now,
    })),
  };

  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      'INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?);',
      duplicate.id,
      duplicate.name,
      duplicate.description,
      duplicate.createdAt,
      duplicate.updatedAt,
    );
    for (const screen of duplicate.screens) {
      await transaction.runAsync(
        'INSERT INTO project_screens (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?);',
        screen.id,
        duplicate.id,
        screen.name,
        screen.position,
        screen.createdAt,
      );
    }
  });

  return duplicate;
}

export async function updateProject(
  db: SQLiteDatabase,
  projectId: string,
  draft: ProjectDraft,
): Promise<void> {
  const result = await db.runAsync(
    'UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?;',
    requireName(draft.name, 'Проект'),
    draft.description.trim(),
    new Date().toISOString(),
    projectId,
  );
  if (result.changes === 0) throw new Error('Проект больше не существует.');
}

export async function deleteProject(
  db: SQLiteDatabase,
  projectId: string,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync('DELETE FROM projects WHERE id = ?;', projectId);
  });
}

export async function createProjectScreen(
  db: SQLiteDatabase,
  projectId: string,
  name: string,
): Promise<ProjectScreen> {
  const screen: ProjectScreen = {
    id: makeId(),
    projectId,
    name: requireName(name, 'Экран'),
    position: 0,
    createdAt: new Date().toISOString(),
  };

  await db.withExclusiveTransactionAsync(async (transaction) => {
    const project = await transaction.getFirstAsync<{ id: string }>(
      'SELECT id FROM projects WHERE id = ?;',
      projectId,
    );
    if (!project) throw new Error('Не удалось найти проект.');
    const nextPosition = await transaction.getFirstAsync<{
      next_position: number;
    }>(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM project_screens WHERE project_id = ?;',
      projectId,
    );
    screen.position = nextPosition?.next_position ?? 0;
    await transaction.runAsync(
      'INSERT INTO project_screens (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?);',
      screen.id,
      screen.projectId,
      screen.name,
      screen.position,
      screen.createdAt,
    );
  });

  return screen;
}

export async function renameProjectScreen(
  db: SQLiteDatabase,
  projectId: string,
  screenId: string,
  name: string,
): Promise<void> {
  const result = await db.runAsync(
    'UPDATE project_screens SET name = ? WHERE id = ? AND project_id = ?;',
    requireName(name, 'Экран'),
    screenId,
    projectId,
  );
  if (result.changes === 0) throw new Error('Экран больше не существует.');
}

export async function deleteProjectScreen(
  db: SQLiteDatabase,
  projectId: string,
  screenId: string,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      'DELETE FROM project_screens WHERE id = ? AND project_id = ?;',
      screenId,
      projectId,
    );
  });
}
