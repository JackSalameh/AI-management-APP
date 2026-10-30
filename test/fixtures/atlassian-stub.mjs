// Stub Jira Cloud, Bitbucket Cloud and GitHub REST APIs for tests and the demo (records every request).
import http from 'node:http';

export async function startStub(port = 0) {
  const seen = [];
  const JIRA_AUTH = `Basic ${Buffer.from('jack@example.com:JIRA-TOKEN').toString('base64')}`;
  const BB_AUTH = `Basic ${Buffer.from('jack@example.com:BB-TOKEN').toString('base64')}`;
  const stub = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const j = body ? JSON.parse(body) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: j });
      const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const u = req.url;
      if (u.startsWith('/jira/')) {
        if (req.headers.authorization !== JIRA_AUTH) return send(401, { errorMessages: ['Client must be authenticated'] });
        if (u === '/jira/rest/api/3/myself') return send(200, { accountId: 'acc-1', displayName: 'Jack Salameh', emailAddress: 'jack@example.com' });
        if (u === '/jira/rest/api/3/search/jql') return send(200, { issues: [{ key: 'X1191-7', id: '10', fields: { summary: 'Calibrate focal length', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, priority: { name: 'High' }, assignee: { displayName: 'Jack Salameh' }, issuetype: { name: 'Task' }, project: { key: 'X1191' }, updated: '2026-10-30T10:00:00.000+0100' } }] });
        if (u.startsWith('/jira/rest/api/3/issue/X1191-7?')) return send(200, { key: 'X1191-7', id: '10', fields: { summary: 'Calibrate focal length', status: { name: 'In Progress' }, description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Use the 25 mm lens.' }] }] }, comment: { comments: [{ id: '1', author: { displayName: 'Ana' }, created: '2026-10-29', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Images are in ./calib' }] }] } }] }, subtasks: [] } });
        if (u === '/jira/rest/api/3/issue/X1191-7/transitions' && req.method === 'GET') return send(200, { transitions: [{ id: '31', name: 'Done', to: { name: 'Done' } }] });
        if (u === '/jira/rest/api/3/issue/X1191-7/transitions') return send(204, {});
        if (u === '/jira/rest/api/3/issue/X1191-7/comment') return send(201, { id: '2' });
        if (u === '/jira/rest/api/3/issue/X1191-7/assignee') return send(204, {});
        if (u.startsWith('/jira/rest/api/3/project/search')) return send(200, { values: [{ key: 'X1191', name: 'Optical bench' }] });
        if (u === '/jira/rest/api/3/issue' && req.method === 'POST') return send(201, { key: 'X1191-8' });
        return send(404, {});
      }
      if (u.startsWith('/bb/')) {
        if (req.headers.authorization !== BB_AUTH) return send(401, { error: { message: 'Unauthorized' } });
        const p = u.slice(3);
        if (p === '/2.0/user') return send(200, { display_name: 'Jack Salameh', username: 'jacks', account_id: 'a1' });
        if (p.startsWith('/2.0/user/permissions/workspaces')) return send(200, { values: [{ workspace: { slug: 'acme', name: 'ACME' } }] });
        if (p.startsWith('/2.0/repositories/acme?')) return send(200, { values: [{ slug: 'optics', name: 'optics', full_name: 'acme/optics', is_private: true, updated_on: '2026-10-30', mainbranch: { name: 'main' }, links: { html: { href: 'https://bitbucket.org/acme/optics' }, clone: [{ name: 'https', href: 'https://jacks@bitbucket.org/acme/optics.git' }, { name: 'ssh', href: 'git@bitbucket.org:acme/optics.git' }] } }] });
        if (p.startsWith('/2.0/repositories/acme/optics/pullrequests?')) return send(200, { values: [{ id: 4, title: 'Add MTF', state: 'OPEN', author: { display_name: 'Ana' }, source: { branch: { name: 'feature/mtf' } }, destination: { branch: { name: 'main' } }, links: { html: { href: 'https://bitbucket.org/acme/optics/pull-requests/4' } }, participants: [] }] });
        if (p === '/2.0/repositories/acme/optics/pullrequests/4') return send(200, { id: 4, title: 'Add MTF', state: 'OPEN', source: { branch: { name: 'feature/mtf' } }, destination: { branch: { name: 'main' } } });
        if (p === '/2.0/repositories/acme/optics/pullrequests/4/diff') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('diff --git a/mtf.m b/mtf.m\n+x = 1;\n'); }
        if (p === '/2.0/repositories/acme/optics/pullrequests/4/approve') return send(200, {});
        if (p === '/2.0/repositories/acme/optics/pullrequests' && req.method === 'POST') return send(201, { id: 5, title: j.title, state: 'OPEN', source: j.source, destination: j.destination || { branch: { name: 'main' } } });
        return send(404, {});
      }
      if (u.startsWith('/gh/')) {
        if (req.headers.authorization !== 'Bearer GH-TOKEN') return send(401, { message: 'Bad credentials' });
        if (u === '/gh/user') return send(200, { login: 'jacks' });
        if (u.startsWith('/gh/user/repos?')) return send(200, [{ full_name: 'jacks/ai-management-app', private: true, updated_at: '2026-10-30', clone_url: 'https://github.com/jacks/ai-management-app.git', ssh_url: 'git@github.com:jacks/ai-management-app.git', html_url: 'https://github.com/jacks/ai-management-app', default_branch: 'main' }]);
        if (u === '/gh/user/repos' && req.method === 'POST') return send(201, { clone_url: `https://github.com/jacks/${j.name}.git` });
        return send(404, {});
      }
      send(404, {});
    });
  });

  await new Promise((r) => stub.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${stub.address().port}`, seen, close: () => { stub.closeAllConnections(); stub.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) { const s = await startStub(+process.argv[2] || 0); console.log(`STUB ${s.url}`); }
