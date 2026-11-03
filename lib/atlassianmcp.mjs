// Official Atlassian Rovo MCP server for Jira and Bitbucket Cloud (transposed from Codex Projects Management 1.9.5,
// where it was checked with the owner's Windows Codex and Atlassian OAuth):
//  - one endpoint for both products and every sign-in method: https://mcp.atlassian.com/v2/mcp?tools=all
//    (browser OAuth works for Bitbucket too; API tokens remain possible),
//  - a separate Codex entry per product with an explicit tool list (consultation, or consultation + changes),
//  - Bitbucket code tools (searchCode…) and guidance that keeps searches remote and scoped (no automatic clone).
// Live catalog check (1.9.4): searchCode, getCodeFile, listCodeDirectory, scanCodeRepo returned; getCodeSymbol and
// diffCodeSymbols are in Atlassian's published catalog but were not returned by that account.
export const ATLASSIAN_ENDPOINT = 'https://mcp.atlassian.com/v2/mcp?tools=all';

const COMMON = ['atlassianUserInfo', 'getAccessibleAtlassianResources'];
export const CODE_TOOLS = ['searchCode', 'getCodeFile', 'listCodeDirectory', 'scanCodeRepo', 'getCodeSymbol', 'diffCodeSymbols'];
const READ = {
  jira: ['getJiraIssue', 'listJiraProjects', 'listJiraProjectIssueTypesMetadata', 'getJiraIssueTypeMetaWithFields', 'listJiraIssueTransitions', 'listJiraIssueLinkTypes', 'listJiraIssueRemoteIssueLinks', 'listJiraIssueWorklogs', 'lookupJiraAccountId', 'listJiraIssueAssignableUsers', 'listJiraIssueComments', 'listJiraIssueChangelogs', 'getJiraCurrentUser', 'getJiraUser', 'listJiraStatuses', 'listJiraProjectComponents', 'getJiraProjectVersions', 'getJiraProjectVersionRelatedWork', 'listJiraBoards', 'getJiraBoardConfig', 'getJiraBoardIssueData', 'getJiraBoardSprintData', 'listJiraBoardSprints', 'listJiraFilters', 'listJiraDashboards', 'getJiraEntityProperty', 'downloadJiraIssueAttachment', 'searchJiraIssuesUsingJql'],
  bitbucket: ['listBitbucketWorkspaces', 'getBitbucketWorkspace', 'listBitbucketRepositories', 'getBitbucketRepository', 'getBitbucketRepoDefaultReviewers', 'getBitbucketRepoFileContent', 'getBitbucketRepoBranch', 'getBitbucketRepoCommit', 'listBitbucketRepoCommitReports', 'getBitbucketRepoCommitReport', 'getBitbucketRepoCommitReportAnnotations', 'listBitbucketRepoPullRequests', 'getBitbucketRepoPullRequest', 'getBitbucketRepoPullRequestDiff', 'listBitbucketRepoPullRequestComments', 'listBitbucketRepoPullRequestTasks', 'listBitbucketRepoPipelines', 'getBitbucketRepoPipeline', 'listBitbucketRepoPipelineSteps', 'getBitbucketRepoPipelineStep', 'getBitbucketRepoPipelineStepLog', 'listBitbucketRepoDeployments', 'getBitbucketRepoDeployment', 'listBitbucketRepoEnvironments', 'getBitbucketRepoEnvironment'],
};
const WRITE = {
  jira: ['createJiraIssue', 'editJiraIssue', 'transitionJiraIssue', 'addOrEditJiraIssueComment', 'addOrEditJiraIssueWorklog', 'createJiraIssueLink', 'watchJiraIssue', 'uploadAttachmentToJiraIssue', 'editJiraEntityProperty', 'createJiraIssueRemoteIssueLink'],
  bitbucket: ['createBitbucketRepoPullRequest', 'updateBitbucketRepoPullRequest', 'mergeBitbucketRepoPullRequest', 'approveBitbucketRepoPullRequest', 'requestChangesOnBitbucketRepoPullRequest', 'addBitbucketRepoPullRequestComment', 'resolveBitbucketRepoPullRequestComment', 'reopenBitbucketRepoPullRequestComment', 'createBitbucketRepoPullRequestTask', 'setBitbucketRepoPullRequestTaskState', 'createBitbucketRepoBranch', 'createBitbucketRepoCommit', 'runBitbucketRepoPipeline'],
};

/** Tools a product's connection may use: consultation ('read') or consultation + changes ('write'). */
export function atlassianTools(product, access = 'read') {
  if (!Object.hasOwn(READ, product) || !['read', 'write'].includes(access)) throw new Error('Choose Jira or Bitbucket and a supported access level.');
  return [...COMMON, ...READ[product], ...(product === 'bitbucket' ? CODE_TOOLS : []), ...(access === 'write' ? WRITE[product] : [])];
}

/** Access level of a configured tool list. */
export function atlassianAccess(product, tools) { return Array.isArray(tools) && tools.some((x) => WRITE[product]?.includes(x)) ? 'write' : 'read'; }

/** Is this an entry of the official server (any query string)? */
export function isOfficialAtlassian(url) {
  try { const u = new URL(url); return u.origin === 'https://mcp.atlassian.com' && /^\/v[12]\/mcp/.test(u.pathname) && !u.username && !u.password; } catch { return false; }
}

/** https://company.atlassian.net (also accepts …/jira). */
export function atlassianSite(value) {
  let u; try { u = new URL(String(value || '').trim()); } catch { throw new Error('Use your Jira Cloud site, for example https://company.atlassian.net.'); }
  if (u.protocol !== 'https:' || !u.hostname.endsWith('.atlassian.net') || u.username || u.password || u.port || u.search || u.hash || !['/', '/jira', '/jira/'].includes(u.pathname)) throw new Error('Use your Jira Cloud site, for example https://company.atlassian.net.');
  return u.origin;
}

/** https://bitbucket.org/<workspace> (a bare workspace slug is accepted too). */
export function atlassianWorkspace(value) {
  const v = String(value || '').trim();
  if (/^[a-zA-Z0-9_-]+$/.test(v)) return `https://bitbucket.org/${v}`;
  let u; try { u = new URL(v); } catch { throw new Error('Use the Bitbucket workspace URL, for example https://bitbucket.org/team.'); }
  const slug = u.pathname.replace(/^\//, '').replace(/\/$/, '');
  if (u.origin !== 'https://bitbucket.org' || u.username || u.password || u.search || u.hash || !/^[a-zA-Z0-9_-]+$/.test(slug)) throw new Error('Use the Bitbucket workspace URL, for example https://bitbucket.org/team.');
  return `https://bitbucket.org/${slug}`;
}

/**
 * Guidance sent to the AI with each message when Jira and/or Bitbucket are connected: which site and workspace,
 * and for Bitbucket how to search (remote tools, scoped, no automatic clone or bulk download).
 */
export function atlassianContext({ site, workspace, jira, bitbucket }) {
  const parts = [];
  if (jira && site) parts.push(`Jira site ${site}`);
  if (bitbucket && workspace) parts.push(`Bitbucket workspace ${workspace}`);
  if (!parts.length) return '';
  let text = `Atlassian connection targets: ${parts.join('; ')}. Resolve accessible resources before selecting the corresponding cloudId. These targets guide the task; account permissions and configured tool filters remain authoritative.`;
  if (bitbucket && workspace) {
    const slug = workspace.split('/').pop();
    text += `\nFor Bitbucket searches and consultation, use the remote MCP tools first. Use searchCode with namespace set to the workspace slug "${slug}" and repo restricted to the repository or repositories explicitly requested. For a known identifier, start with lexical mode; use hybrid or semantic mode for related concepts. If "project" could mean a single repository, a Bitbucket project containing several repositories, or the whole workspace, resolve the intended scope from the conversation and repository metadata; clarify before expanding to unrelated repositories. Start with a bounded result set, then inspect relevant matches with getCodeFile or getBitbucketRepoFileContent. Use directory listings when needed. Do not clone repositories, download repository archives, or recursively fetch every file as an automatic search fallback. Local retrieval requires an explicit user request or approval of a concrete, bounded retrieval plan. If remote search is unavailable, lacks permissions, or does not cover all requested files or branches, report the limitation and the scope actually searched. Never claim an indexed search is exhaustive.`;
  }
  return text;
}
