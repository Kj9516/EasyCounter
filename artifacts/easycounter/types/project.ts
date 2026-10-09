export interface ProjectScreen {
  id: string;
  projectId: string;
  name: string;
  position: number;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  screens: ProjectScreen[];
}

export interface ProjectDraft {
  name: string;
  description: string;
}
