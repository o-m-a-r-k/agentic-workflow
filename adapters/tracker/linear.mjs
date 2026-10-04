// Linear through the agent's MCP connector. The engine holds no Linear credentials:
// the agent performs each operation and saves the raw responses as one capture file.
const first = (...values) => values.find((v) => v !== undefined && v !== null);
const list = (v) => (Array.isArray(v) ? v : Array.isArray(v?.nodes) ? v.nodes : []);

export default {
  via: 'agent',
  operations: {
    readIssue: 'Linear get_issue (include comments and attachments) or list_comments',
    setStatus: 'Linear save_issue with the status name',
    comment: 'Linear save_comment; reuse an existing comment with the same body instead of posting a duplicate',
    attach: 'Linear create_attachment with title equal to the file name',
    readBack: 'Linear get_issue + list_comments + attachments, saved together as JSON',
  },
  captureShape: '{ "issue": <get_issue response>, "comments": [<comments>], "attachments": [<attachments>] }',
  rules: { attachmentTitleIsFilename: true },
  normalize(raw) {
    const issue = raw.issue ?? raw;
    return {
      id: first(issue.identifier, issue.id),
      title: issue.title ?? '',
      status: first(issue.state?.name, issue.status?.name, issue.status, issue.state),
      url: issue.url ?? null,
      updatedAt: issue.updatedAt ?? null,
      comments: list(first(raw.comments, issue.comments)).map((c) => ({ id: c.id, body: c.body ?? '', createdAt: c.createdAt, updatedAt: c.updatedAt ?? c.createdAt })),
      attachments: list(first(raw.attachments, issue.attachments)).map((a) => ({ id: a.id, title: a.title ?? '', filename: a.filename ?? a.title ?? '', url: a.url })),
    };
  },
};
