export interface PullRequestRecord {
  id: number;
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
}

export interface PullRequestGateway {
  createOrUpdate(input: {
    repositoryFullName: string;
    branchName: string;
    defaultBranch: string;
    title: string;
    body: string;
  }): Promise<PullRequestRecord>;
}
