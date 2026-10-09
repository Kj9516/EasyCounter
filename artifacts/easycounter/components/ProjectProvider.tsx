import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  createProject as saveProject,
  createProjectScreen as saveScreen,
  deleteProject as removeProject,
  deleteProjectScreen as removeScreen,
  duplicateProject as copyProject,
  listProjects,
  renameProjectScreen,
  updateProject as saveProjectChanges,
} from '@/storage/database';
import type { Project, ProjectDraft, ProjectScreen } from '@/types/project';

interface ProjectContextValue {
  projects: Project[];
  isLoading: boolean;
  error: string | null;
  clearError: () => void;
  refresh: () => Promise<void>;
  createProject: (draft: ProjectDraft) => Promise<Project>;
  duplicateProject: (projectId: string) => Promise<Project>;
  updateProject: (projectId: string, draft: ProjectDraft) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  createScreen: (projectId: string, name: string) => Promise<ProjectScreen>;
  renameScreen: (projectId: string, screenId: string, name: string) => Promise<void>;
  deleteScreen: (projectId: string, screenId: string) => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

function messageFromError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Не удалось сохранить изменения. Попробуйте еще раз.';
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setProjects(await listProjects());
    } catch (loadError) {
      setError(messageFromError(loadError));
      throw loadError;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshAfterMutation = useCallback(async () => {
    setProjects(await listProjects());
  }, []);

  const mutate = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T> => {
      setError(null);
      try {
        const result = await operation();
        await refreshAfterMutation();
        return result;
      } catch (mutationError) {
        setError(messageFromError(mutationError));
        throw mutationError;
      }
    },
    [refreshAfterMutation],
  );

  useEffect(() => {
    let active = true;
    void listProjects()
      .then((savedProjects) => {
        if (active) setProjects(savedProjects);
      })
      .catch((loadError: unknown) => {
        if (active) setError(messageFromError(loadError));
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<ProjectContextValue>(
    () => ({
      projects,
      isLoading,
      error,
      clearError: () => setError(null),
      refresh,
      createProject: (draft) => mutate(() => saveProject(draft)),
      duplicateProject: (projectId) => mutate(() => copyProject(projectId)),
      updateProject: (projectId, draft) =>
        mutate(() => saveProjectChanges(projectId, draft)),
      deleteProject: (projectId) => mutate(() => removeProject(projectId)),
      createScreen: (projectId, name) =>
        mutate(() => saveScreen(projectId, name)),
      renameScreen: (projectId, screenId, name) =>
        mutate(() => renameProjectScreen(projectId, screenId, name)),
      deleteScreen: (projectId, screenId) =>
        mutate(() => removeScreen(projectId, screenId)),
    }),
    [projects, isLoading, error, refresh, mutate],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProjects(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProjects must be used within ProjectProvider.');
  }
  return context;
}
