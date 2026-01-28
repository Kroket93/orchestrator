import { Injectable, OnModuleInit } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { LoggerService } from '../logger/logger.service.js';

const execAsync = promisify(exec);

/** Default data directory for Orchestrator */
const DEFAULT_DATA_DIR = '/home/claude/data';

/** GitHub organization/user for repos */
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'Kroket93';

/** Projects directory on the host */
const PROJECTS_DIR = process.env.PROJECTS_DIR || '/home/claude/projects';

/** Agent workspaces directory */
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || '/home/claude/agent-workspaces';

/** Pull request information */
export interface PullRequest {
  number: number;
  url: string;
  htmlUrl: string;
  state: 'open' | 'closed' | 'merged';
  title: string;
  body: string;
  head: string;
  base: string;
  mergeable: boolean | null;
  merged: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Result of push operation */
export interface PushResult {
  success: boolean;
  branch: string;
  remote: string;
  message: string;
}

/** Result of PR creation */
export interface CreatePrResult {
  success: boolean;
  prNumber: number;
  prUrl: string;
  message: string;
}

/** Result of PR merge */
export interface MergePrResult {
  success: boolean;
  merged: boolean;
  message: string;
  sha?: string;
}

/** Repository info */
export interface RepoInfo {
  name: string;
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
}

@Injectable()
export class GithubService implements OnModuleInit {
  private githubToken: string = '';
  private tokenWarningLogged = false;

  constructor(private readonly logger: LoggerService) {}

  onModuleInit(): void {
    this.loadToken();
  }

  /**
   * Load the GitHub token from file or environment.
   */
  private loadToken(): void {
    const dataDir = process.env.ORCHESTRATOR_DATA_DIR || DEFAULT_DATA_DIR;
    const tokenPath = path.join(dataDir, '.github-token');

    try {
      if (fs.existsSync(tokenPath)) {
        this.githubToken = fs.readFileSync(tokenPath, 'utf-8').trim();
        this.logger.info('github', `GitHub token loaded from ${tokenPath}`);
      } else {
        // Fall back to environment variable
        this.githubToken = process.env.GITHUB_TOKEN || '';
        if (this.githubToken) {
          this.logger.info('github', 'GitHub token loaded from environment variable');
        }
      }
    } catch (error) {
      this.logger.error('github', `Failed to load GitHub token: ${error}`);
    }
  }

  /**
   * Log a warning if GitHub token is not configured (only once).
   */
  private checkToken(): void {
    if (!this.githubToken && !this.tokenWarningLogged) {
      this.tokenWarningLogged = true;
      this.logger.warn('github', 'GitHub token not configured - GitHub operations will fail');
    }
  }

  /**
   * Make an authenticated request to the GitHub API.
   */
  private async githubApi<T>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    this.checkToken();

    const url = endpoint.startsWith('https://')
      ? endpoint
      : `https://api.github.com${endpoint}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.githubToken}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Orchestrator-Agent',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${errorBody}`);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * Check if a repository exists on GitHub.
   */
  async repoExists(repo: string): Promise<boolean> {
    try {
      await this.githubApi('GET', `/repos/${GITHUB_OWNER}/${repo}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get repository information from GitHub.
   */
  async getRepo(repo: string): Promise<RepoInfo | null> {
    try {
      const data = await this.githubApi<{
        name: string;
        full_name: string;
        html_url: string;
        clone_url: string;
        default_branch: string;
        private: boolean;
      }>('GET', `/repos/${GITHUB_OWNER}/${repo}`);

      return {
        name: data.name,
        fullName: data.full_name,
        htmlUrl: data.html_url,
        cloneUrl: data.clone_url,
        defaultBranch: data.default_branch,
        private: data.private,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get the default branch name for a repository.
   */
  async getDefaultBranch(repo: string): Promise<string> {
    try {
      const repoInfo = await this.getRepo(repo);
      return repoInfo?.defaultBranch ?? 'main';
    } catch {
      return 'main';
    }
  }

  /**
   * Create a new repository on GitHub.
   */
  async createRepo(
    repo: string,
    options?: { description?: string; private?: boolean },
  ): Promise<RepoInfo> {
    this.logger.info('github', `Creating repository: ${repo}`);

    const data = await this.githubApi<{
      name: string;
      full_name: string;
      html_url: string;
      clone_url: string;
      default_branch: string;
      private: boolean;
    }>('POST', '/user/repos', {
      name: repo,
      description: options?.description || `Repository for ${repo}`,
      private: options?.private ?? false,
      auto_init: false,
    });

    this.logger.info('github', `Repository created: ${data.html_url}`);

    return {
      name: data.name,
      fullName: data.full_name,
      htmlUrl: data.html_url,
      cloneUrl: data.clone_url,
      defaultBranch: data.default_branch,
      private: data.private,
    };
  }

  /**
   * Ensure a local repository has a GitHub remote configured.
   */
  async ensureRemote(repo: string): Promise<{ remote: string; created: boolean }> {
    const repoPath = `${PROJECTS_DIR}/${repo}`;

    if (!fs.existsSync(repoPath)) {
      throw new Error(`Local repository not found: ${repoPath}`);
    }

    // Check if origin remote exists
    try {
      const { stdout } = await execAsync('git remote get-url origin', { cwd: repoPath });
      const existingRemote = stdout.trim();

      // Verify it points to our GitHub
      if (existingRemote.includes('github.com') && existingRemote.includes(GITHUB_OWNER)) {
        return { remote: existingRemote, created: false };
      }

      // Remote exists but points elsewhere - update it
      const newRemote = `https://github.com/${GITHUB_OWNER}/${repo}.git`;
      await execAsync(`git remote set-url origin ${newRemote}`, { cwd: repoPath });
      this.logger.info('github', `Updated remote for ${repo} to ${newRemote}`);
      return { remote: newRemote, created: false };
    } catch {
      // No origin remote - need to add one
    }

    // Check if GitHub repo exists
    const exists = await this.repoExists(repo);

    if (!exists) {
      // Create the repo on GitHub
      await this.createRepo(repo);
    }

    // Add the remote
    const remoteUrl = `https://github.com/${GITHUB_OWNER}/${repo}.git`;
    await execAsync(`git remote add origin ${remoteUrl}`, { cwd: repoPath });
    this.logger.info('github', `Added remote for ${repo}: ${remoteUrl}`);

    // If we created a new GitHub repo, push main branch immediately
    if (!exists) {
      await this.initializeMainBranch(repo, repoPath);
    }

    return { remote: remoteUrl, created: !exists };
  }

  /**
   * Push the main branch to a newly created GitHub repo.
   */
  private async initializeMainBranch(repo: string, repoPath: string): Promise<void> {
    try {
      // Check if there are any commits on the current branch
      const { stdout: hasCommits } = await execAsync('git rev-parse HEAD 2>/dev/null || echo ""', { cwd: repoPath });

      if (!hasCommits.trim()) {
        this.logger.info('github', `No commits in ${repo} yet, skipping main branch push`);
        return;
      }

      // Get current branch name
      const { stdout: currentBranch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
      const branch = currentBranch.trim();

      // If we're not on main, check if main exists and has commits
      let branchToPush = branch;
      if (branch !== 'main') {
        try {
          await execAsync('git rev-parse main 2>/dev/null', { cwd: repoPath });
          branchToPush = 'main';
        } catch {
          // main doesn't exist, use current branch
          this.logger.info('github', `No main branch in ${repo}, will push ${branch} as initial branch`);
        }
      }

      // Push with authentication
      const authRemote = `https://${GITHUB_OWNER}:${this.githubToken}@github.com/${GITHUB_OWNER}/${repo}.git`;

      this.logger.info('github', `Initializing GitHub repo ${repo} by pushing ${branchToPush} branch`);

      // Add temporary authenticated remote, push, then remove
      await execAsync(`git remote add github-init "${authRemote}" 2>/dev/null || git remote set-url github-init "${authRemote}"`, { cwd: repoPath });
      await execAsync(`git push -u github-init ${branchToPush}`, { cwd: repoPath, timeout: 60000 });
      await execAsync('git remote remove github-init', { cwd: repoPath }).catch(() => {});

      this.logger.info('github', `Successfully initialized ${repo} with ${branchToPush} branch as default`);
    } catch (error) {
      const err = error as Error;
      this.logger.warn('github', `Failed to initialize main branch for ${repo}: ${err.message}`);
    }
  }

  /**
   * Push a branch from an agent's workspace to GitHub.
   */
  async pushBranch(repo: string, agentId: string, branch: string): Promise<PushResult> {
    const workspacePath = `${WORKSPACES_DIR}/${agentId}/repo`;

    if (!fs.existsSync(workspacePath)) {
      throw new Error(`Agent workspace not found: ${workspacePath}`);
    }

    // Ensure the production repo has a remote (we'll push to that remote)
    const { remote } = await this.ensureRemote(repo);

    // Configure git credentials for this push
    const authRemote = remote.replace(
      'https://github.com',
      `https://${GITHUB_OWNER}:${this.githubToken}@github.com`,
    );

    this.logger.info('github', `Pushing branch ${branch} for ${repo} (agent: ${agentId})`);

    try {
      // Add the authenticated remote temporarily
      await execAsync(`git remote add github-push "${authRemote}" 2>/dev/null || git remote set-url github-push "${authRemote}"`, {
        cwd: workspacePath,
      });

      // Push the branch
      const { stdout, stderr } = await execAsync(`git push -u github-push ${branch}`, {
        cwd: workspacePath,
        timeout: 120000, // 2 minutes
      });

      // Remove the authenticated remote
      await execAsync('git remote remove github-push', { cwd: workspacePath }).catch(() => {});

      this.logger.info('github', `Successfully pushed ${branch} to ${repo}`);

      return {
        success: true,
        branch,
        remote: `https://github.com/${GITHUB_OWNER}/${repo}`,
        message: `Pushed ${branch}\n${stdout}${stderr}`,
      };
    } catch (error) {
      // Clean up remote on failure
      await execAsync('git remote remove github-push', { cwd: workspacePath }).catch(() => {});

      const err = error as { message: string; stderr?: string };
      this.logger.error('github', `Failed to push ${branch}: ${err.message}`);

      return {
        success: false,
        branch,
        remote: remote,
        message: `Push failed: ${err.message}\n${err.stderr || ''}`,
      };
    }
  }

  /**
   * Create a pull request on GitHub.
   */
  async createPullRequest(
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<CreatePrResult> {
    this.logger.info('github', `Creating PR for ${repo}: ${head} -> ${base}`);

    try {
      const data = await this.githubApi<{
        number: number;
        html_url: string;
      }>('POST', `/repos/${GITHUB_OWNER}/${repo}/pulls`, {
        title,
        body,
        head,
        base,
      });

      this.logger.info('github', `PR created: ${data.html_url}`);

      return {
        success: true,
        prNumber: data.number,
        prUrl: data.html_url,
        message: `Pull request #${data.number} created`,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error('github', `Failed to create PR: ${err.message}`);

      return {
        success: false,
        prNumber: 0,
        prUrl: '',
        message: `Failed to create PR: ${err.message}`,
      };
    }
  }

  /**
   * Get pull request information.
   */
  async getPullRequest(repo: string, prNumber: number): Promise<PullRequest | null> {
    try {
      const data = await this.githubApi<{
        number: number;
        url: string;
        html_url: string;
        state: 'open' | 'closed';
        title: string;
        body: string;
        head: { ref: string };
        base: { ref: string };
        mergeable: boolean | null;
        merged: boolean;
        created_at: string;
        updated_at: string;
      }>('GET', `/repos/${GITHUB_OWNER}/${repo}/pulls/${prNumber}`);

      return {
        number: data.number,
        url: data.url,
        htmlUrl: data.html_url,
        state: data.merged ? 'merged' : data.state,
        title: data.title,
        body: data.body || '',
        head: data.head.ref,
        base: data.base.ref,
        mergeable: data.mergeable,
        merged: data.merged,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      };
    } catch {
      return null;
    }
  }

  /**
   * Merge a pull request.
   */
  async mergePullRequest(
    repo: string,
    prNumber: number,
    options?: { commitTitle?: string; mergeMethod?: 'merge' | 'squash' | 'rebase' },
  ): Promise<MergePrResult> {
    this.logger.info('github', `Merging PR #${prNumber} for ${repo}`);

    try {
      const data = await this.githubApi<{
        merged: boolean;
        message: string;
        sha: string;
      }>('PUT', `/repos/${GITHUB_OWNER}/${repo}/pulls/${prNumber}/merge`, {
        commit_title: options?.commitTitle,
        merge_method: options?.mergeMethod || 'squash',
      });

      this.logger.info('github', `PR #${prNumber} merged: ${data.sha}`);

      return {
        success: true,
        merged: data.merged,
        message: data.message,
        sha: data.sha,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error('github', `Failed to merge PR #${prNumber}: ${err.message}`);

      return {
        success: false,
        merged: false,
        message: `Failed to merge: ${err.message}`,
      };
    }
  }

  /**
   * List open pull requests for a repository.
   */
  async listPullRequests(repo: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<PullRequest[]> {
    try {
      const data = await this.githubApi<Array<{
        number: number;
        url: string;
        html_url: string;
        state: 'open' | 'closed';
        title: string;
        body: string;
        head: { ref: string };
        base: { ref: string };
        mergeable: boolean | null;
        merged: boolean;
        created_at: string;
        updated_at: string;
      }>>('GET', `/repos/${GITHUB_OWNER}/${repo}/pulls?state=${state}`);

      return data.map((pr) => ({
        number: pr.number,
        url: pr.url,
        htmlUrl: pr.html_url,
        state: pr.merged ? 'merged' : pr.state,
        title: pr.title,
        body: pr.body || '',
        head: pr.head.ref,
        base: pr.base.ref,
        mergeable: pr.mergeable,
        merged: pr.merged,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get the GitHub owner/organization name.
   */
  getOwner(): string {
    return GITHUB_OWNER;
  }

  /**
   * Check if the GitHub token is configured.
   */
  isConfigured(): boolean {
    return !!this.githubToken;
  }

  /**
   * Get the clone URL for a repository.
   * Returns an authenticated URL if token is available (supports private repos).
   */
  getCloneUrl(repo: string): string {
    if (this.githubToken) {
      return `https://${GITHUB_OWNER}:${this.githubToken}@github.com/${GITHUB_OWNER}/${repo}.git`;
    }
    return `https://github.com/${GITHUB_OWNER}/${repo}.git`;
  }
}
