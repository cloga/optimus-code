"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../src/managers/TaskManifestManager.ts
var TaskManifestManager_exports = {};
__export(TaskManifestManager_exports, {
  TaskManifestManager: () => TaskManifestManager
});
function withManifestLock(fn) {
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  const prev = manifestMutex;
  manifestMutex = next;
  return prev.then(() => {
    try {
      const result = fn();
      return result;
    } finally {
      release();
    }
  });
}
var fs2, path2, manifestMutex, TaskManifestManager;
var init_TaskManifestManager = __esm({
  "../src/managers/TaskManifestManager.ts"() {
    "use strict";
    fs2 = __toESM(require("fs"));
    path2 = __toESM(require("path"));
    manifestMutex = Promise.resolve();
    TaskManifestManager = class {
      static getManifestPath(workspacePath) {
        return path2.join(workspacePath, ".optimus", "state", "task-manifest.json");
      }
      static loadManifest(workspacePath) {
        const manifestPath = this.getManifestPath(workspacePath);
        if (!fs2.existsSync(manifestPath)) {
          return {};
        }
        try {
          return JSON.parse(fs2.readFileSync(manifestPath, "utf8"));
        } catch {
          return {};
        }
      }
      static saveManifest(workspacePath, manifest) {
        const manifestPath = this.getManifestPath(workspacePath);
        const tempPath = `${manifestPath}.tmp`;
        const dir = path2.dirname(manifestPath);
        if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
        fs2.writeFileSync(tempPath, JSON.stringify(manifest, null, 2), "utf8");
        fs2.renameSync(tempPath, manifestPath);
      }
      static createTask(workspacePath, record) {
        const fullRecord = {
          ...record,
          status: "pending",
          startTime: Date.now(),
          heartbeatTime: Date.now()
        };
        withManifestLock(() => {
          const manifest = this.loadManifest(workspacePath);
          manifest[record.taskId] = fullRecord;
          this.saveManifest(workspacePath, manifest);
        });
        return fullRecord;
      }
      static updateTask(workspacePath, taskId, updates) {
        withManifestLock(() => {
          const manifest = this.loadManifest(workspacePath);
          if (manifest[taskId]) {
            manifest[taskId] = { ...manifest[taskId], ...updates };
            this.saveManifest(workspacePath, manifest);
          }
        });
      }
      static heartbeat(workspacePath, taskId) {
        withManifestLock(() => {
          const manifest = this.loadManifest(workspacePath);
          if (manifest[taskId]) {
            manifest[taskId].heartbeatTime = Date.now();
            this.saveManifest(workspacePath, manifest);
          }
        });
      }
      static reapStaleTasks(workspacePath) {
        withManifestLock(() => {
          const manifest = this.loadManifest(workspacePath);
          const now = Date.now();
          const TIMEOUT_MS = 1e3 * 60 * 3;
          let changed = false;
          for (const taskId in manifest) {
            const task = manifest[taskId];
            if (task.status === "running") {
              if (now - task.heartbeatTime > TIMEOUT_MS) {
                task.status = "failed";
                task.error_message = "Task timed out or runner process died (reaped by Watchdog).";
                changed = true;
                try {
                  if (task.output_path) {
                    const dir = path2.dirname(task.output_path);
                    if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
                    fs2.writeFileSync(task.output_path, `\u274C **Fatal Error**: ${task.error_message}
`, "utf8");
                  }
                } catch (e) {
                }
              }
            }
          }
          if (changed) {
            this.saveManifest(workspacePath, manifest);
          }
        });
      }
    };
  }
});

// ../src/adapters/vcs/GitHubProvider.ts
var GitHubProvider_exports = {};
__export(GitHubProvider_exports, {
  GitHubProvider: () => GitHubProvider
});
var GitHubProvider;
var init_GitHubProvider = __esm({
  "../src/adapters/vcs/GitHubProvider.ts"() {
    "use strict";
    GitHubProvider = class {
      owner;
      repo;
      constructor(owner, repo) {
        this.owner = owner;
        this.repo = repo;
      }
      async createWorkItem(title, body, labels, workItemType, _adoOptions) {
        const token = this.getToken();
        if (!token) {
          throw new Error("GitHub token not found in environment variables");
        }
        const taggedTitle = title.startsWith("[Optimus]") ? title : `[Optimus] ${title}`;
        const issueLabels = Array.isArray(labels) ? [...labels] : [];
        if (!issueLabels.includes("optimus-bot")) {
          issueLabels.push("optimus-bot");
        }
        try {
          const response = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/issues`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github.v3+json",
              "Content-Type": "application/json",
              "User-Agent": "Optimus-Agent"
            },
            body: JSON.stringify({
              title: taggedTitle,
              body,
              labels: issueLabels
            })
          });
          if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status} ${await response.text()}`);
          }
          const data = await response.json();
          return {
            id: data.id.toString(),
            number: data.number,
            url: data.html_url,
            title: data.title
          };
        } catch (error) {
          throw new Error(`Failed to create GitHub issue: ${error.message}`);
        }
      }
      async createPullRequest(title, body, head, base) {
        const token = this.getToken();
        if (!token) {
          throw new Error("GitHub token not found in environment variables");
        }
        const taggedTitle = title.startsWith("[Optimus]") ? title : `[Optimus] ${title}`;
        try {
          const response = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/pulls`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github.v3+json",
              "Content-Type": "application/json",
              "User-Agent": "Optimus-Agent"
            },
            body: JSON.stringify({
              title: taggedTitle,
              head,
              base,
              body: body || ""
            })
          });
          if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status} ${await response.text()}`);
          }
          const data = await response.json();
          try {
            await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/issues/${data.number}/labels`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/vnd.github.v3+json",
                "Content-Type": "application/json",
                "User-Agent": "Optimus-Agent"
              },
              body: JSON.stringify({ labels: ["optimus-bot"] })
            });
          } catch {
          }
          return {
            id: data.id.toString(),
            number: data.number,
            url: data.html_url,
            title: data.title
          };
        } catch (error) {
          throw new Error(`Failed to create GitHub pull request: ${error.message}`);
        }
      }
      async mergePullRequest(pullRequestId, commitTitle, mergeMethod = "squash") {
        const token = this.getToken();
        if (!token) {
          throw new Error("GitHub token not found in environment variables");
        }
        const prNumber = typeof pullRequestId === "string" ? parseInt(pullRequestId) : pullRequestId;
        const PROTECTED_BRANCHES = ["master", "main", "develop", "release"];
        try {
          const prResponse = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/pulls/${prNumber}`, {
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github.v3+json",
              "User-Agent": "Optimus-Agent"
            }
          });
          let headBranch;
          let baseBranch;
          if (prResponse.ok) {
            const prData = await prResponse.json();
            headBranch = prData.head?.ref;
            baseBranch = prData.base?.ref;
          }
          const payload = { merge_method: mergeMethod };
          if (commitTitle) {
            payload.commit_title = commitTitle;
          }
          const response = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/pulls/${prNumber}/merge`, {
            method: "PUT",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github.v3+json",
              "Content-Type": "application/json",
              "User-Agent": "Optimus-Agent"
            },
            body: JSON.stringify(payload)
          });
          if (!response.ok) {
            return { merged: false, headBranch, baseBranch };
          }
          if (headBranch && !PROTECTED_BRANCHES.includes(headBranch)) {
            try {
              await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/git/refs/heads/${headBranch}`, {
                method: "DELETE",
                headers: {
                  "Authorization": `Bearer ${token}`,
                  "Accept": "application/vnd.github.v3+json",
                  "User-Agent": "Optimus-Agent"
                }
              });
            } catch {
              console.error(`[Branch Cleanup] Warning: failed to delete remote branch '${headBranch}'`);
            }
          }
          return { merged: true, headBranch, baseBranch };
        } catch {
          return { merged: false };
        }
      }
      async addComment(itemType, itemId, comment) {
        const token = this.getToken();
        if (!token) {
          throw new Error("GitHub token not found in environment variables");
        }
        const id = typeof itemId === "string" ? parseInt(itemId) : itemId;
        try {
          const response = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/issues/${id}/comments`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github.v3+json",
              "Content-Type": "application/json",
              "User-Agent": "Optimus-Agent"
            },
            body: JSON.stringify({ body: comment })
          });
          if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status} ${await response.text()}`);
          }
          const data = await response.json();
          return {
            id: data.id.toString(),
            url: data.html_url
          };
        } catch (error) {
          throw new Error(`Failed to add GitHub comment: ${error.message}`);
        }
      }
      getProviderName() {
        return "github";
      }
      getToken() {
        return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      }
    };
  }
});

// ../node_modules/marked/lib/marked.esm.js
function M() {
  return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
}
function G(u3) {
  T = u3;
}
function k(u3, e = "") {
  let t = typeof u3 == "string" ? u3 : u3.source, n = { replace: (r, i) => {
    let s = typeof i == "string" ? i : i.source;
    return s = s.replace(m.caret, "$1"), t = t.replace(r, s), n;
  }, getRegex: () => new RegExp(t, e) };
  return n;
}
function O(u3, e) {
  if (e) {
    if (m.escapeTest.test(u3)) return u3.replace(m.escapeReplace, de);
  } else if (m.escapeTestNoEncode.test(u3)) return u3.replace(m.escapeReplaceNoEncode, de);
  return u3;
}
function X(u3) {
  try {
    u3 = encodeURI(u3).replace(m.percentDecode, "%");
  } catch {
    return null;
  }
  return u3;
}
function J(u3, e) {
  let t = u3.replace(m.findPipe, (i, s, a) => {
    let o = false, l = s;
    for (; --l >= 0 && a[l] === "\\"; ) o = !o;
    return o ? "|" : " |";
  }), n = t.split(m.splitPipe), r = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e) if (n.length > e) n.splice(e);
  else for (; n.length < e; ) n.push("");
  for (; r < n.length; r++) n[r] = n[r].trim().replace(m.slashPipe, "|");
  return n;
}
function E(u3, e, t) {
  let n = u3.length;
  if (n === 0) return "";
  let r = 0;
  for (; r < n; ) {
    let i = u3.charAt(n - r - 1);
    if (i === e && !t) r++;
    else if (i !== e && t) r++;
    else break;
  }
  return u3.slice(0, n - r);
}
function ge(u3, e) {
  if (u3.indexOf(e[1]) === -1) return -1;
  let t = 0;
  for (let n = 0; n < u3.length; n++) if (u3[n] === "\\") n++;
  else if (u3[n] === e[0]) t++;
  else if (u3[n] === e[1] && (t--, t < 0)) return n;
  return t > 0 ? -2 : -1;
}
function fe(u3, e = 0) {
  let t = e, n = "";
  for (let r of u3) if (r === "	") {
    let i = 4 - t % 4;
    n += " ".repeat(i), t += i;
  } else n += r, t++;
  return n;
}
function me(u3, e, t, n, r) {
  let i = e.href, s = e.title || null, a = u3[1].replace(r.other.outputLinkReplace, "$1");
  n.state.inLink = true;
  let o = { type: u3[0].charAt(0) === "!" ? "image" : "link", raw: t, href: i, title: s, text: a, tokens: n.inlineTokens(a) };
  return n.state.inLink = false, o;
}
function it(u3, e, t) {
  let n = u3.match(t.other.indentCodeCompensation);
  if (n === null) return e;
  let r = n[1];
  return e.split(`
`).map((i) => {
    let s = i.match(t.other.beginningSpace);
    if (s === null) return i;
    let [a] = s;
    return a.length >= r.length ? i.slice(r.length) : i;
  }).join(`
`);
}
function g(u3, e) {
  return L.parse(u3, e);
}
var T, _, Re, m, Te, Oe, we, A, ye, N, re, se, Pe, Q, Se, j, $e, _e, q, F, Le, ie, Me, U, te, ze, Ee, Ie, Ae, oe, Ce, v, K, ae, Be, le, De, qe, ue, ve, He, Ge, pe, Ze, Ne, ce, Qe, je, Fe, Ue, Ke, We, Xe, Je, Ve, Ye, D, et, he, ke, tt, ne, W, nt, Z, rt, C, z, st, de, w, x, y, $, b, P, B, L, Ut, Kt, Wt, Xt, Jt, Yt, en;
var init_marked_esm = __esm({
  "../node_modules/marked/lib/marked.esm.js"() {
    "use strict";
    T = M();
    _ = { exec: () => null };
    Re = (() => {
      try {
        return !!new RegExp("(?<=1)(?<!1)");
      } catch {
        return false;
      }
    })();
    m = { codeRemoveIndent: /^(?: {1,4}| {0,3}\t)/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (u3) => new RegExp(`^( {0,3}${u3})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: (u3) => new RegExp(`^ {0,${Math.min(3, u3 - 1)}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`), hrRegex: (u3) => new RegExp(`^ {0,${Math.min(3, u3 - 1)}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`), fencesBeginRegex: (u3) => new RegExp(`^ {0,${Math.min(3, u3 - 1)}}(?:\`\`\`|~~~)`), headingBeginRegex: (u3) => new RegExp(`^ {0,${Math.min(3, u3 - 1)}}#`), htmlBeginRegex: (u3) => new RegExp(`^ {0,${Math.min(3, u3 - 1)}}<(?:[a-z].*>|!--)`, "i"), blockquoteBeginRegex: (u3) => new RegExp(`^ {0,${Math.min(3, u3 - 1)}}>`) };
    Te = /^(?:[ \t]*(?:\n|$))+/;
    Oe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
    we = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
    A = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
    ye = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
    N = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
    re = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
    se = k(re).replace(/bull/g, N).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
    Pe = k(re).replace(/bull/g, N).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
    Q = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/;
    Se = /^[^\n]+/;
    j = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
    $e = k(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", j).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
    _e = k(/^(bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g, N).getRegex();
    q = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
    F = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
    Le = k("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", F).replace("tag", q).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
    ie = k(Q).replace("hr", A).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", q).getRegex();
    Me = k(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", ie).getRegex();
    U = { blockquote: Me, code: Oe, def: $e, fences: we, heading: ye, hr: A, html: Le, lheading: se, list: _e, newline: Te, paragraph: ie, table: _, text: Se };
    te = k("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", A).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", q).getRegex();
    ze = { ...U, lheading: Pe, table: te, paragraph: k(Q).replace("hr", A).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", te).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", q).getRegex() };
    Ee = { ...U, html: k(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", F).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: _, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: k(Q).replace("hr", A).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", se).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
    Ie = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
    Ae = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
    oe = /^( {2,}|\\)\n(?!\s*$)/;
    Ce = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
    v = /[\p{P}\p{S}]/u;
    K = /[\s\p{P}\p{S}]/u;
    ae = /[^\s\p{P}\p{S}]/u;
    Be = k(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, K).getRegex();
    le = /(?!~)[\p{P}\p{S}]/u;
    De = /(?!~)[\s\p{P}\p{S}]/u;
    qe = /(?:[^\s\p{P}\p{S}]|~)/u;
    ue = /(?![*_])[\p{P}\p{S}]/u;
    ve = /(?![*_])[\s\p{P}\p{S}]/u;
    He = /(?:[^\s\p{P}\p{S}]|[*_])/u;
    Ge = k(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", Re ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
    pe = /^(?:\*+(?:((?!\*)punct)|[^\s*]))|^_+(?:((?!_)punct)|([^\s_]))/;
    Ze = k(pe, "u").replace(/punct/g, v).getRegex();
    Ne = k(pe, "u").replace(/punct/g, le).getRegex();
    ce = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
    Qe = k(ce, "gu").replace(/notPunctSpace/g, ae).replace(/punctSpace/g, K).replace(/punct/g, v).getRegex();
    je = k(ce, "gu").replace(/notPunctSpace/g, qe).replace(/punctSpace/g, De).replace(/punct/g, le).getRegex();
    Fe = k("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, ae).replace(/punctSpace/g, K).replace(/punct/g, v).getRegex();
    Ue = k(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, ue).getRegex();
    Ke = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
    We = k(Ke, "gu").replace(/notPunctSpace/g, He).replace(/punctSpace/g, ve).replace(/punct/g, ue).getRegex();
    Xe = k(/\\(punct)/, "gu").replace(/punct/g, v).getRegex();
    Je = k(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
    Ve = k(F).replace("(?:-->|$)", "-->").getRegex();
    Ye = k("^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", Ve).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
    D = /(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+[^`]*?`+(?!`)|[^\[\]\\`])*?/;
    et = k(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/).replace("label", D).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
    he = k(/^!?\[(label)\]\[(ref)\]/).replace("label", D).replace("ref", j).getRegex();
    ke = k(/^!?\[(ref)\](?:\[\])?/).replace("ref", j).getRegex();
    tt = k("reflink|nolink(?!\\()", "g").replace("reflink", he).replace("nolink", ke).getRegex();
    ne = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
    W = { _backpedal: _, anyPunctuation: Xe, autolink: Je, blockSkip: Ge, br: oe, code: Ae, del: _, delLDelim: _, delRDelim: _, emStrongLDelim: Ze, emStrongRDelimAst: Qe, emStrongRDelimUnd: Fe, escape: Ie, link: et, nolink: ke, punctuation: Be, reflink: he, reflinkSearch: tt, tag: Ye, text: Ce, url: _ };
    nt = { ...W, link: k(/^!?\[(label)\]\((.*?)\)/).replace("label", D).getRegex(), reflink: k(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", D).getRegex() };
    Z = { ...W, emStrongRDelimAst: je, emStrongLDelim: Ne, delLDelim: Ue, delRDelim: We, url: k(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("protocol", ne).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: k(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace("protocol", ne).getRegex() };
    rt = { ...Z, br: k(oe).replace("{2,}", "*").getRegex(), text: k(Z.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
    C = { normal: U, gfm: ze, pedantic: Ee };
    z = { normal: W, gfm: Z, breaks: rt, pedantic: nt };
    st = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    de = (u3) => st[u3];
    w = class {
      options;
      rules;
      lexer;
      constructor(e) {
        this.options = e || T;
      }
      space(e) {
        let t = this.rules.block.newline.exec(e);
        if (t && t[0].length > 0) return { type: "space", raw: t[0] };
      }
      code(e) {
        let t = this.rules.block.code.exec(e);
        if (t) {
          let n = t[0].replace(this.rules.other.codeRemoveIndent, "");
          return { type: "code", raw: t[0], codeBlockStyle: "indented", text: this.options.pedantic ? n : E(n, `
`) };
        }
      }
      fences(e) {
        let t = this.rules.block.fences.exec(e);
        if (t) {
          let n = t[0], r = it(n, t[3] || "", this.rules);
          return { type: "code", raw: n, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: r };
        }
      }
      heading(e) {
        let t = this.rules.block.heading.exec(e);
        if (t) {
          let n = t[2].trim();
          if (this.rules.other.endingHash.test(n)) {
            let r = E(n, "#");
            (this.options.pedantic || !r || this.rules.other.endingSpaceChar.test(r)) && (n = r.trim());
          }
          return { type: "heading", raw: t[0], depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
        }
      }
      hr(e) {
        let t = this.rules.block.hr.exec(e);
        if (t) return { type: "hr", raw: E(t[0], `
`) };
      }
      blockquote(e) {
        let t = this.rules.block.blockquote.exec(e);
        if (t) {
          let n = E(t[0], `
`).split(`
`), r = "", i = "", s = [];
          for (; n.length > 0; ) {
            let a = false, o = [], l;
            for (l = 0; l < n.length; l++) if (this.rules.other.blockquoteStart.test(n[l])) o.push(n[l]), a = true;
            else if (!a) o.push(n[l]);
            else break;
            n = n.slice(l);
            let p = o.join(`
`), c = p.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
            r = r ? `${r}
${p}` : p, i = i ? `${i}
${c}` : c;
            let d = this.lexer.state.top;
            if (this.lexer.state.top = true, this.lexer.blockTokens(c, s, true), this.lexer.state.top = d, n.length === 0) break;
            let h = s.at(-1);
            if (h?.type === "code") break;
            if (h?.type === "blockquote") {
              let R = h, f = R.raw + `
` + n.join(`
`), S = this.blockquote(f);
              s[s.length - 1] = S, r = r.substring(0, r.length - R.raw.length) + S.raw, i = i.substring(0, i.length - R.text.length) + S.text;
              break;
            } else if (h?.type === "list") {
              let R = h, f = R.raw + `
` + n.join(`
`), S = this.list(f);
              s[s.length - 1] = S, r = r.substring(0, r.length - h.raw.length) + S.raw, i = i.substring(0, i.length - R.raw.length) + S.raw, n = f.substring(s.at(-1).raw.length).split(`
`);
              continue;
            }
          }
          return { type: "blockquote", raw: r, tokens: s, text: i };
        }
      }
      list(e) {
        let t = this.rules.block.list.exec(e);
        if (t) {
          let n = t[1].trim(), r = n.length > 1, i = { type: "list", raw: "", ordered: r, start: r ? +n.slice(0, -1) : "", loose: false, items: [] };
          n = r ? `\\d{1,9}\\${n.slice(-1)}` : `\\${n}`, this.options.pedantic && (n = r ? n : "[*+-]");
          let s = this.rules.other.listItemRegex(n), a = false;
          for (; e; ) {
            let l = false, p = "", c = "";
            if (!(t = s.exec(e)) || this.rules.block.hr.test(e)) break;
            p = t[0], e = e.substring(p.length);
            let d = fe(t[2].split(`
`, 1)[0], t[1].length), h = e.split(`
`, 1)[0], R = !d.trim(), f = 0;
            if (this.options.pedantic ? (f = 2, c = d.trimStart()) : R ? f = t[1].length + 1 : (f = d.search(this.rules.other.nonSpaceChar), f = f > 4 ? 1 : f, c = d.slice(f), f += t[1].length), R && this.rules.other.blankLine.test(h) && (p += h + `
`, e = e.substring(h.length + 1), l = true), !l) {
              let S = this.rules.other.nextBulletRegex(f), V = this.rules.other.hrRegex(f), Y = this.rules.other.fencesBeginRegex(f), ee = this.rules.other.headingBeginRegex(f), xe = this.rules.other.htmlBeginRegex(f), be = this.rules.other.blockquoteBeginRegex(f);
              for (; e; ) {
                let H = e.split(`
`, 1)[0], I;
                if (h = H, this.options.pedantic ? (h = h.replace(this.rules.other.listReplaceNesting, "  "), I = h) : I = h.replace(this.rules.other.tabCharGlobal, "    "), Y.test(h) || ee.test(h) || xe.test(h) || be.test(h) || S.test(h) || V.test(h)) break;
                if (I.search(this.rules.other.nonSpaceChar) >= f || !h.trim()) c += `
` + I.slice(f);
                else {
                  if (R || d.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || Y.test(d) || ee.test(d) || V.test(d)) break;
                  c += `
` + h;
                }
                R = !h.trim(), p += H + `
`, e = e.substring(H.length + 1), d = I.slice(f);
              }
            }
            i.loose || (a ? i.loose = true : this.rules.other.doubleBlankLine.test(p) && (a = true)), i.items.push({ type: "list_item", raw: p, task: !!this.options.gfm && this.rules.other.listIsTask.test(c), loose: false, text: c, tokens: [] }), i.raw += p;
          }
          let o = i.items.at(-1);
          if (o) o.raw = o.raw.trimEnd(), o.text = o.text.trimEnd();
          else return;
          i.raw = i.raw.trimEnd();
          for (let l of i.items) {
            if (this.lexer.state.top = false, l.tokens = this.lexer.blockTokens(l.text, []), l.task) {
              if (l.text = l.text.replace(this.rules.other.listReplaceTask, ""), l.tokens[0]?.type === "text" || l.tokens[0]?.type === "paragraph") {
                l.tokens[0].raw = l.tokens[0].raw.replace(this.rules.other.listReplaceTask, ""), l.tokens[0].text = l.tokens[0].text.replace(this.rules.other.listReplaceTask, "");
                for (let c = this.lexer.inlineQueue.length - 1; c >= 0; c--) if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[c].src)) {
                  this.lexer.inlineQueue[c].src = this.lexer.inlineQueue[c].src.replace(this.rules.other.listReplaceTask, "");
                  break;
                }
              }
              let p = this.rules.other.listTaskCheckbox.exec(l.raw);
              if (p) {
                let c = { type: "checkbox", raw: p[0] + " ", checked: p[0] !== "[ ]" };
                l.checked = c.checked, i.loose ? l.tokens[0] && ["paragraph", "text"].includes(l.tokens[0].type) && "tokens" in l.tokens[0] && l.tokens[0].tokens ? (l.tokens[0].raw = c.raw + l.tokens[0].raw, l.tokens[0].text = c.raw + l.tokens[0].text, l.tokens[0].tokens.unshift(c)) : l.tokens.unshift({ type: "paragraph", raw: c.raw, text: c.raw, tokens: [c] }) : l.tokens.unshift(c);
              }
            }
            if (!i.loose) {
              let p = l.tokens.filter((d) => d.type === "space"), c = p.length > 0 && p.some((d) => this.rules.other.anyLine.test(d.raw));
              i.loose = c;
            }
          }
          if (i.loose) for (let l of i.items) {
            l.loose = true;
            for (let p of l.tokens) p.type === "text" && (p.type = "paragraph");
          }
          return i;
        }
      }
      html(e) {
        let t = this.rules.block.html.exec(e);
        if (t) return { type: "html", block: true, raw: t[0], pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: t[0] };
      }
      def(e) {
        let t = this.rules.block.def.exec(e);
        if (t) {
          let n = t[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal, " "), r = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", i = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
          return { type: "def", tag: n, raw: t[0], href: r, title: i };
        }
      }
      table(e) {
        let t = this.rules.block.table.exec(e);
        if (!t || !this.rules.other.tableDelimiter.test(t[2])) return;
        let n = J(t[1]), r = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), i = t[3]?.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], s = { type: "table", raw: t[0], header: [], align: [], rows: [] };
        if (n.length === r.length) {
          for (let a of r) this.rules.other.tableAlignRight.test(a) ? s.align.push("right") : this.rules.other.tableAlignCenter.test(a) ? s.align.push("center") : this.rules.other.tableAlignLeft.test(a) ? s.align.push("left") : s.align.push(null);
          for (let a = 0; a < n.length; a++) s.header.push({ text: n[a], tokens: this.lexer.inline(n[a]), header: true, align: s.align[a] });
          for (let a of i) s.rows.push(J(a, s.header.length).map((o, l) => ({ text: o, tokens: this.lexer.inline(o), header: false, align: s.align[l] })));
          return s;
        }
      }
      lheading(e) {
        let t = this.rules.block.lheading.exec(e);
        if (t) return { type: "heading", raw: t[0], depth: t[2].charAt(0) === "=" ? 1 : 2, text: t[1], tokens: this.lexer.inline(t[1]) };
      }
      paragraph(e) {
        let t = this.rules.block.paragraph.exec(e);
        if (t) {
          let n = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
          return { type: "paragraph", raw: t[0], text: n, tokens: this.lexer.inline(n) };
        }
      }
      text(e) {
        let t = this.rules.block.text.exec(e);
        if (t) return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
      }
      escape(e) {
        let t = this.rules.inline.escape.exec(e);
        if (t) return { type: "escape", raw: t[0], text: t[1] };
      }
      tag(e) {
        let t = this.rules.inline.tag.exec(e);
        if (t) return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
      }
      link(e) {
        let t = this.rules.inline.link.exec(e);
        if (t) {
          let n = t[2].trim();
          if (!this.options.pedantic && this.rules.other.startAngleBracket.test(n)) {
            if (!this.rules.other.endAngleBracket.test(n)) return;
            let s = E(n.slice(0, -1), "\\");
            if ((n.length - s.length) % 2 === 0) return;
          } else {
            let s = ge(t[2], "()");
            if (s === -2) return;
            if (s > -1) {
              let o = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + s;
              t[2] = t[2].substring(0, s), t[0] = t[0].substring(0, o).trim(), t[3] = "";
            }
          }
          let r = t[2], i = "";
          if (this.options.pedantic) {
            let s = this.rules.other.pedanticHrefTitle.exec(r);
            s && (r = s[1], i = s[3]);
          } else i = t[3] ? t[3].slice(1, -1) : "";
          return r = r.trim(), this.rules.other.startAngleBracket.test(r) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(n) ? r = r.slice(1) : r = r.slice(1, -1)), me(t, { href: r && r.replace(this.rules.inline.anyPunctuation, "$1"), title: i && i.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
        }
      }
      reflink(e, t) {
        let n;
        if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
          let r = (n[2] || n[1]).replace(this.rules.other.multipleSpaceGlobal, " "), i = t[r.toLowerCase()];
          if (!i) {
            let s = n[0].charAt(0);
            return { type: "text", raw: s, text: s };
          }
          return me(n, i, n[0], this.lexer, this.rules);
        }
      }
      emStrong(e, t, n = "") {
        let r = this.rules.inline.emStrongLDelim.exec(e);
        if (!r || r[3] && n.match(this.rules.other.unicodeAlphaNumeric)) return;
        if (!(r[1] || r[2] || "") || !n || this.rules.inline.punctuation.exec(n)) {
          let s = [...r[0]].length - 1, a, o, l = s, p = 0, c = r[0][0] === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
          for (c.lastIndex = 0, t = t.slice(-1 * e.length + s); (r = c.exec(t)) != null; ) {
            if (a = r[1] || r[2] || r[3] || r[4] || r[5] || r[6], !a) continue;
            if (o = [...a].length, r[3] || r[4]) {
              l += o;
              continue;
            } else if ((r[5] || r[6]) && s % 3 && !((s + o) % 3)) {
              p += o;
              continue;
            }
            if (l -= o, l > 0) continue;
            o = Math.min(o, o + l + p);
            let d = [...r[0]][0].length, h = e.slice(0, s + r.index + d + o);
            if (Math.min(s, o) % 2) {
              let f = h.slice(1, -1);
              return { type: "em", raw: h, text: f, tokens: this.lexer.inlineTokens(f) };
            }
            let R = h.slice(2, -2);
            return { type: "strong", raw: h, text: R, tokens: this.lexer.inlineTokens(R) };
          }
        }
      }
      codespan(e) {
        let t = this.rules.inline.code.exec(e);
        if (t) {
          let n = t[2].replace(this.rules.other.newLineCharGlobal, " "), r = this.rules.other.nonSpaceChar.test(n), i = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
          return r && i && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t[0], text: n };
        }
      }
      br(e) {
        let t = this.rules.inline.br.exec(e);
        if (t) return { type: "br", raw: t[0] };
      }
      del(e, t, n = "") {
        let r = this.rules.inline.delLDelim.exec(e);
        if (!r) return;
        if (!(r[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
          let s = [...r[0]].length - 1, a, o, l = s, p = this.rules.inline.delRDelim;
          for (p.lastIndex = 0, t = t.slice(-1 * e.length + s); (r = p.exec(t)) != null; ) {
            if (a = r[1] || r[2] || r[3] || r[4] || r[5] || r[6], !a || (o = [...a].length, o !== s)) continue;
            if (r[3] || r[4]) {
              l += o;
              continue;
            }
            if (l -= o, l > 0) continue;
            o = Math.min(o, o + l);
            let c = [...r[0]][0].length, d = e.slice(0, s + r.index + c + o), h = d.slice(s, -s);
            return { type: "del", raw: d, text: h, tokens: this.lexer.inlineTokens(h) };
          }
        }
      }
      autolink(e) {
        let t = this.rules.inline.autolink.exec(e);
        if (t) {
          let n, r;
          return t[2] === "@" ? (n = t[1], r = "mailto:" + n) : (n = t[1], r = n), { type: "link", raw: t[0], text: n, href: r, tokens: [{ type: "text", raw: n, text: n }] };
        }
      }
      url(e) {
        let t;
        if (t = this.rules.inline.url.exec(e)) {
          let n, r;
          if (t[2] === "@") n = t[0], r = "mailto:" + n;
          else {
            let i;
            do
              i = t[0], t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? "";
            while (i !== t[0]);
            n = t[0], t[1] === "www." ? r = "http://" + t[0] : r = t[0];
          }
          return { type: "link", raw: t[0], text: n, href: r, tokens: [{ type: "text", raw: n, text: n }] };
        }
      }
      inlineText(e) {
        let t = this.rules.inline.text.exec(e);
        if (t) {
          let n = this.lexer.state.inRawBlock;
          return { type: "text", raw: t[0], text: t[0], escaped: n };
        }
      }
    };
    x = class u {
      tokens;
      options;
      state;
      inlineQueue;
      tokenizer;
      constructor(e) {
        this.tokens = [], this.tokens.links = /* @__PURE__ */ Object.create(null), this.options = e || T, this.options.tokenizer = this.options.tokenizer || new w(), this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, top: true };
        let t = { other: m, block: C.normal, inline: z.normal };
        this.options.pedantic ? (t.block = C.pedantic, t.inline = z.pedantic) : this.options.gfm && (t.block = C.gfm, this.options.breaks ? t.inline = z.breaks : t.inline = z.gfm), this.tokenizer.rules = t;
      }
      static get rules() {
        return { block: C, inline: z };
      }
      static lex(e, t) {
        return new u(t).lex(e);
      }
      static lexInline(e, t) {
        return new u(t).inlineTokens(e);
      }
      lex(e) {
        e = e.replace(m.carriageReturn, `
`), this.blockTokens(e, this.tokens);
        for (let t = 0; t < this.inlineQueue.length; t++) {
          let n = this.inlineQueue[t];
          this.inlineTokens(n.src, n.tokens);
        }
        return this.inlineQueue = [], this.tokens;
      }
      blockTokens(e, t = [], n = false) {
        for (this.options.pedantic && (e = e.replace(m.tabCharGlobal, "    ").replace(m.spaceLine, "")); e; ) {
          let r;
          if (this.options.extensions?.block?.some((s) => (r = s.call({ lexer: this }, e, t)) ? (e = e.substring(r.raw.length), t.push(r), true) : false)) continue;
          if (r = this.tokenizer.space(e)) {
            e = e.substring(r.raw.length);
            let s = t.at(-1);
            r.raw.length === 1 && s !== void 0 ? s.raw += `
` : t.push(r);
            continue;
          }
          if (r = this.tokenizer.code(e)) {
            e = e.substring(r.raw.length);
            let s = t.at(-1);
            s?.type === "paragraph" || s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.at(-1).src = s.text) : t.push(r);
            continue;
          }
          if (r = this.tokenizer.fences(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.heading(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.hr(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.blockquote(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.list(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.html(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.def(e)) {
            e = e.substring(r.raw.length);
            let s = t.at(-1);
            s?.type === "paragraph" || s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.raw, this.inlineQueue.at(-1).src = s.text) : this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }, t.push(r));
            continue;
          }
          if (r = this.tokenizer.table(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          if (r = this.tokenizer.lheading(e)) {
            e = e.substring(r.raw.length), t.push(r);
            continue;
          }
          let i = e;
          if (this.options.extensions?.startBlock) {
            let s = 1 / 0, a = e.slice(1), o;
            this.options.extensions.startBlock.forEach((l) => {
              o = l.call({ lexer: this }, a), typeof o == "number" && o >= 0 && (s = Math.min(s, o));
            }), s < 1 / 0 && s >= 0 && (i = e.substring(0, s + 1));
          }
          if (this.state.top && (r = this.tokenizer.paragraph(i))) {
            let s = t.at(-1);
            n && s?.type === "paragraph" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = s.text) : t.push(r), n = i.length !== e.length, e = e.substring(r.raw.length);
            continue;
          }
          if (r = this.tokenizer.text(e)) {
            e = e.substring(r.raw.length);
            let s = t.at(-1);
            s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = s.text) : t.push(r);
            continue;
          }
          if (e) {
            let s = "Infinite loop on byte: " + e.charCodeAt(0);
            if (this.options.silent) {
              console.error(s);
              break;
            } else throw new Error(s);
          }
        }
        return this.state.top = true, t;
      }
      inline(e, t = []) {
        return this.inlineQueue.push({ src: e, tokens: t }), t;
      }
      inlineTokens(e, t = []) {
        let n = e, r = null;
        if (this.tokens.links) {
          let o = Object.keys(this.tokens.links);
          if (o.length > 0) for (; (r = this.tokenizer.rules.inline.reflinkSearch.exec(n)) != null; ) o.includes(r[0].slice(r[0].lastIndexOf("[") + 1, -1)) && (n = n.slice(0, r.index) + "[" + "a".repeat(r[0].length - 2) + "]" + n.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex));
        }
        for (; (r = this.tokenizer.rules.inline.anyPunctuation.exec(n)) != null; ) n = n.slice(0, r.index) + "++" + n.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);
        let i;
        for (; (r = this.tokenizer.rules.inline.blockSkip.exec(n)) != null; ) i = r[2] ? r[2].length : 0, n = n.slice(0, r.index + i) + "[" + "a".repeat(r[0].length - i - 2) + "]" + n.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);
        n = this.options.hooks?.emStrongMask?.call({ lexer: this }, n) ?? n;
        let s = false, a = "";
        for (; e; ) {
          s || (a = ""), s = false;
          let o;
          if (this.options.extensions?.inline?.some((p) => (o = p.call({ lexer: this }, e, t)) ? (e = e.substring(o.raw.length), t.push(o), true) : false)) continue;
          if (o = this.tokenizer.escape(e)) {
            e = e.substring(o.raw.length), t.push(o);
            continue;
          }
          if (o = this.tokenizer.tag(e)) {
            e = e.substring(o.raw.length), t.push(o);
            continue;
          }
          if (o = this.tokenizer.link(e)) {
            e = e.substring(o.raw.length), t.push(o);
            continue;
          }
          if (o = this.tokenizer.reflink(e, this.tokens.links)) {
            e = e.substring(o.raw.length);
            let p = t.at(-1);
            o.type === "text" && p?.type === "text" ? (p.raw += o.raw, p.text += o.text) : t.push(o);
            continue;
          }
          if (o = this.tokenizer.emStrong(e, n, a)) {
            e = e.substring(o.raw.length), t.push(o);
            continue;
          }
          if (o = this.tokenizer.codespan(e)) {
            e = e.substring(o.raw.length), t.push(o);
            continue;
          }
          if (o = this.tokenizer.br(e)) {
            e = e.substring(o.raw.length), t.push(o);
            continue;
          }
          if (o = this.tokenizer.del(e, n, a)) {
            e = e.substring(o.raw.length), t.push(o);
            continue;
          }
          if (o = this.tokenizer.autolink(e)) {
            e = e.substring(o.raw.length), t.push(o);
            continue;
          }
          if (!this.state.inLink && (o = this.tokenizer.url(e))) {
            e = e.substring(o.raw.length), t.push(o);
            continue;
          }
          let l = e;
          if (this.options.extensions?.startInline) {
            let p = 1 / 0, c = e.slice(1), d;
            this.options.extensions.startInline.forEach((h) => {
              d = h.call({ lexer: this }, c), typeof d == "number" && d >= 0 && (p = Math.min(p, d));
            }), p < 1 / 0 && p >= 0 && (l = e.substring(0, p + 1));
          }
          if (o = this.tokenizer.inlineText(l)) {
            e = e.substring(o.raw.length), o.raw.slice(-1) !== "_" && (a = o.raw.slice(-1)), s = true;
            let p = t.at(-1);
            p?.type === "text" ? (p.raw += o.raw, p.text += o.text) : t.push(o);
            continue;
          }
          if (e) {
            let p = "Infinite loop on byte: " + e.charCodeAt(0);
            if (this.options.silent) {
              console.error(p);
              break;
            } else throw new Error(p);
          }
        }
        return t;
      }
    };
    y = class {
      options;
      parser;
      constructor(e) {
        this.options = e || T;
      }
      space(e) {
        return "";
      }
      code({ text: e, lang: t, escaped: n }) {
        let r = (t || "").match(m.notSpaceStart)?.[0], i = e.replace(m.endingNewline, "") + `
`;
        return r ? '<pre><code class="language-' + O(r) + '">' + (n ? i : O(i, true)) + `</code></pre>
` : "<pre><code>" + (n ? i : O(i, true)) + `</code></pre>
`;
      }
      blockquote({ tokens: e }) {
        return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
      }
      html({ text: e }) {
        return e;
      }
      def(e) {
        return "";
      }
      heading({ tokens: e, depth: t }) {
        return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
      }
      hr(e) {
        return `<hr>
`;
      }
      list(e) {
        let t = e.ordered, n = e.start, r = "";
        for (let a = 0; a < e.items.length; a++) {
          let o = e.items[a];
          r += this.listitem(o);
        }
        let i = t ? "ol" : "ul", s = t && n !== 1 ? ' start="' + n + '"' : "";
        return "<" + i + s + `>
` + r + "</" + i + `>
`;
      }
      listitem(e) {
        return `<li>${this.parser.parse(e.tokens)}</li>
`;
      }
      checkbox({ checked: e }) {
        return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
      }
      paragraph({ tokens: e }) {
        return `<p>${this.parser.parseInline(e)}</p>
`;
      }
      table(e) {
        let t = "", n = "";
        for (let i = 0; i < e.header.length; i++) n += this.tablecell(e.header[i]);
        t += this.tablerow({ text: n });
        let r = "";
        for (let i = 0; i < e.rows.length; i++) {
          let s = e.rows[i];
          n = "";
          for (let a = 0; a < s.length; a++) n += this.tablecell(s[a]);
          r += this.tablerow({ text: n });
        }
        return r && (r = `<tbody>${r}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + r + `</table>
`;
      }
      tablerow({ text: e }) {
        return `<tr>
${e}</tr>
`;
      }
      tablecell(e) {
        let t = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
        return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t + `</${n}>
`;
      }
      strong({ tokens: e }) {
        return `<strong>${this.parser.parseInline(e)}</strong>`;
      }
      em({ tokens: e }) {
        return `<em>${this.parser.parseInline(e)}</em>`;
      }
      codespan({ text: e }) {
        return `<code>${O(e, true)}</code>`;
      }
      br(e) {
        return "<br>";
      }
      del({ tokens: e }) {
        return `<del>${this.parser.parseInline(e)}</del>`;
      }
      link({ href: e, title: t, tokens: n }) {
        let r = this.parser.parseInline(n), i = X(e);
        if (i === null) return r;
        e = i;
        let s = '<a href="' + e + '"';
        return t && (s += ' title="' + O(t) + '"'), s += ">" + r + "</a>", s;
      }
      image({ href: e, title: t, text: n, tokens: r }) {
        r && (n = this.parser.parseInline(r, this.parser.textRenderer));
        let i = X(e);
        if (i === null) return O(n);
        e = i;
        let s = `<img src="${e}" alt="${O(n)}"`;
        return t && (s += ` title="${O(t)}"`), s += ">", s;
      }
      text(e) {
        return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : "escaped" in e && e.escaped ? e.text : O(e.text);
      }
    };
    $ = class {
      strong({ text: e }) {
        return e;
      }
      em({ text: e }) {
        return e;
      }
      codespan({ text: e }) {
        return e;
      }
      del({ text: e }) {
        return e;
      }
      html({ text: e }) {
        return e;
      }
      text({ text: e }) {
        return e;
      }
      link({ text: e }) {
        return "" + e;
      }
      image({ text: e }) {
        return "" + e;
      }
      br() {
        return "";
      }
      checkbox({ raw: e }) {
        return e;
      }
    };
    b = class u2 {
      options;
      renderer;
      textRenderer;
      constructor(e) {
        this.options = e || T, this.options.renderer = this.options.renderer || new y(), this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new $();
      }
      static parse(e, t) {
        return new u2(t).parse(e);
      }
      static parseInline(e, t) {
        return new u2(t).parseInline(e);
      }
      parse(e) {
        let t = "";
        for (let n = 0; n < e.length; n++) {
          let r = e[n];
          if (this.options.extensions?.renderers?.[r.type]) {
            let s = r, a = this.options.extensions.renderers[s.type].call({ parser: this }, s);
            if (a !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "html", "def", "paragraph", "text"].includes(s.type)) {
              t += a || "";
              continue;
            }
          }
          let i = r;
          switch (i.type) {
            case "space": {
              t += this.renderer.space(i);
              break;
            }
            case "hr": {
              t += this.renderer.hr(i);
              break;
            }
            case "heading": {
              t += this.renderer.heading(i);
              break;
            }
            case "code": {
              t += this.renderer.code(i);
              break;
            }
            case "table": {
              t += this.renderer.table(i);
              break;
            }
            case "blockquote": {
              t += this.renderer.blockquote(i);
              break;
            }
            case "list": {
              t += this.renderer.list(i);
              break;
            }
            case "checkbox": {
              t += this.renderer.checkbox(i);
              break;
            }
            case "html": {
              t += this.renderer.html(i);
              break;
            }
            case "def": {
              t += this.renderer.def(i);
              break;
            }
            case "paragraph": {
              t += this.renderer.paragraph(i);
              break;
            }
            case "text": {
              t += this.renderer.text(i);
              break;
            }
            default: {
              let s = 'Token with "' + i.type + '" type was not found.';
              if (this.options.silent) return console.error(s), "";
              throw new Error(s);
            }
          }
        }
        return t;
      }
      parseInline(e, t = this.renderer) {
        let n = "";
        for (let r = 0; r < e.length; r++) {
          let i = e[r];
          if (this.options.extensions?.renderers?.[i.type]) {
            let a = this.options.extensions.renderers[i.type].call({ parser: this }, i);
            if (a !== false || !["escape", "html", "link", "image", "strong", "em", "codespan", "br", "del", "text"].includes(i.type)) {
              n += a || "";
              continue;
            }
          }
          let s = i;
          switch (s.type) {
            case "escape": {
              n += t.text(s);
              break;
            }
            case "html": {
              n += t.html(s);
              break;
            }
            case "link": {
              n += t.link(s);
              break;
            }
            case "image": {
              n += t.image(s);
              break;
            }
            case "checkbox": {
              n += t.checkbox(s);
              break;
            }
            case "strong": {
              n += t.strong(s);
              break;
            }
            case "em": {
              n += t.em(s);
              break;
            }
            case "codespan": {
              n += t.codespan(s);
              break;
            }
            case "br": {
              n += t.br(s);
              break;
            }
            case "del": {
              n += t.del(s);
              break;
            }
            case "text": {
              n += t.text(s);
              break;
            }
            default: {
              let a = 'Token with "' + s.type + '" type was not found.';
              if (this.options.silent) return console.error(a), "";
              throw new Error(a);
            }
          }
        }
        return n;
      }
    };
    P = class {
      options;
      block;
      constructor(e) {
        this.options = e || T;
      }
      static passThroughHooks = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"]);
      static passThroughHooksRespectAsync = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens"]);
      preprocess(e) {
        return e;
      }
      postprocess(e) {
        return e;
      }
      processAllTokens(e) {
        return e;
      }
      emStrongMask(e) {
        return e;
      }
      provideLexer() {
        return this.block ? x.lex : x.lexInline;
      }
      provideParser() {
        return this.block ? b.parse : b.parseInline;
      }
    };
    B = class {
      defaults = M();
      options = this.setOptions;
      parse = this.parseMarkdown(true);
      parseInline = this.parseMarkdown(false);
      Parser = b;
      Renderer = y;
      TextRenderer = $;
      Lexer = x;
      Tokenizer = w;
      Hooks = P;
      constructor(...e) {
        this.use(...e);
      }
      walkTokens(e, t) {
        let n = [];
        for (let r of e) switch (n = n.concat(t.call(this, r)), r.type) {
          case "table": {
            let i = r;
            for (let s of i.header) n = n.concat(this.walkTokens(s.tokens, t));
            for (let s of i.rows) for (let a of s) n = n.concat(this.walkTokens(a.tokens, t));
            break;
          }
          case "list": {
            let i = r;
            n = n.concat(this.walkTokens(i.items, t));
            break;
          }
          default: {
            let i = r;
            this.defaults.extensions?.childTokens?.[i.type] ? this.defaults.extensions.childTokens[i.type].forEach((s) => {
              let a = i[s].flat(1 / 0);
              n = n.concat(this.walkTokens(a, t));
            }) : i.tokens && (n = n.concat(this.walkTokens(i.tokens, t)));
          }
        }
        return n;
      }
      use(...e) {
        let t = this.defaults.extensions || { renderers: {}, childTokens: {} };
        return e.forEach((n) => {
          let r = { ...n };
          if (r.async = this.defaults.async || r.async || false, n.extensions && (n.extensions.forEach((i) => {
            if (!i.name) throw new Error("extension name required");
            if ("renderer" in i) {
              let s = t.renderers[i.name];
              s ? t.renderers[i.name] = function(...a) {
                let o = i.renderer.apply(this, a);
                return o === false && (o = s.apply(this, a)), o;
              } : t.renderers[i.name] = i.renderer;
            }
            if ("tokenizer" in i) {
              if (!i.level || i.level !== "block" && i.level !== "inline") throw new Error("extension level must be 'block' or 'inline'");
              let s = t[i.level];
              s ? s.unshift(i.tokenizer) : t[i.level] = [i.tokenizer], i.start && (i.level === "block" ? t.startBlock ? t.startBlock.push(i.start) : t.startBlock = [i.start] : i.level === "inline" && (t.startInline ? t.startInline.push(i.start) : t.startInline = [i.start]));
            }
            "childTokens" in i && i.childTokens && (t.childTokens[i.name] = i.childTokens);
          }), r.extensions = t), n.renderer) {
            let i = this.defaults.renderer || new y(this.defaults);
            for (let s in n.renderer) {
              if (!(s in i)) throw new Error(`renderer '${s}' does not exist`);
              if (["options", "parser"].includes(s)) continue;
              let a = s, o = n.renderer[a], l = i[a];
              i[a] = (...p) => {
                let c = o.apply(i, p);
                return c === false && (c = l.apply(i, p)), c || "";
              };
            }
            r.renderer = i;
          }
          if (n.tokenizer) {
            let i = this.defaults.tokenizer || new w(this.defaults);
            for (let s in n.tokenizer) {
              if (!(s in i)) throw new Error(`tokenizer '${s}' does not exist`);
              if (["options", "rules", "lexer"].includes(s)) continue;
              let a = s, o = n.tokenizer[a], l = i[a];
              i[a] = (...p) => {
                let c = o.apply(i, p);
                return c === false && (c = l.apply(i, p)), c;
              };
            }
            r.tokenizer = i;
          }
          if (n.hooks) {
            let i = this.defaults.hooks || new P();
            for (let s in n.hooks) {
              if (!(s in i)) throw new Error(`hook '${s}' does not exist`);
              if (["options", "block"].includes(s)) continue;
              let a = s, o = n.hooks[a], l = i[a];
              P.passThroughHooks.has(s) ? i[a] = (p) => {
                if (this.defaults.async && P.passThroughHooksRespectAsync.has(s)) return (async () => {
                  let d = await o.call(i, p);
                  return l.call(i, d);
                })();
                let c = o.call(i, p);
                return l.call(i, c);
              } : i[a] = (...p) => {
                if (this.defaults.async) return (async () => {
                  let d = await o.apply(i, p);
                  return d === false && (d = await l.apply(i, p)), d;
                })();
                let c = o.apply(i, p);
                return c === false && (c = l.apply(i, p)), c;
              };
            }
            r.hooks = i;
          }
          if (n.walkTokens) {
            let i = this.defaults.walkTokens, s = n.walkTokens;
            r.walkTokens = function(a) {
              let o = [];
              return o.push(s.call(this, a)), i && (o = o.concat(i.call(this, a))), o;
            };
          }
          this.defaults = { ...this.defaults, ...r };
        }), this;
      }
      setOptions(e) {
        return this.defaults = { ...this.defaults, ...e }, this;
      }
      lexer(e, t) {
        return x.lex(e, t ?? this.defaults);
      }
      parser(e, t) {
        return b.parse(e, t ?? this.defaults);
      }
      parseMarkdown(e) {
        return (n, r) => {
          let i = { ...r }, s = { ...this.defaults, ...i }, a = this.onError(!!s.silent, !!s.async);
          if (this.defaults.async === true && i.async === false) return a(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
          if (typeof n > "u" || n === null) return a(new Error("marked(): input parameter is undefined or null"));
          if (typeof n != "string") return a(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
          if (s.hooks && (s.hooks.options = s, s.hooks.block = e), s.async) return (async () => {
            let o = s.hooks ? await s.hooks.preprocess(n) : n, p = await (s.hooks ? await s.hooks.provideLexer() : e ? x.lex : x.lexInline)(o, s), c = s.hooks ? await s.hooks.processAllTokens(p) : p;
            s.walkTokens && await Promise.all(this.walkTokens(c, s.walkTokens));
            let h = await (s.hooks ? await s.hooks.provideParser() : e ? b.parse : b.parseInline)(c, s);
            return s.hooks ? await s.hooks.postprocess(h) : h;
          })().catch(a);
          try {
            s.hooks && (n = s.hooks.preprocess(n));
            let l = (s.hooks ? s.hooks.provideLexer() : e ? x.lex : x.lexInline)(n, s);
            s.hooks && (l = s.hooks.processAllTokens(l)), s.walkTokens && this.walkTokens(l, s.walkTokens);
            let c = (s.hooks ? s.hooks.provideParser() : e ? b.parse : b.parseInline)(l, s);
            return s.hooks && (c = s.hooks.postprocess(c)), c;
          } catch (o) {
            return a(o);
          }
        };
      }
      onError(e, t) {
        return (n) => {
          if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
            let r = "<p>An error occurred:</p><pre>" + O(n.message + "", true) + "</pre>";
            return t ? Promise.resolve(r) : r;
          }
          if (t) return Promise.reject(n);
          throw n;
        };
      }
    };
    L = new B();
    g.options = g.setOptions = function(u3) {
      return L.setOptions(u3), g.defaults = L.defaults, G(g.defaults), g;
    };
    g.getDefaults = M;
    g.defaults = T;
    g.use = function(...u3) {
      return L.use(...u3), g.defaults = L.defaults, G(g.defaults), g;
    };
    g.walkTokens = function(u3, e) {
      return L.walkTokens(u3, e);
    };
    g.parseInline = L.parseInline;
    g.Parser = b;
    g.parser = b.parse;
    g.Renderer = y;
    g.TextRenderer = $;
    g.Lexer = x;
    g.lexer = x.lex;
    g.Tokenizer = w;
    g.Hooks = P;
    g.parse = g;
    Ut = g.options;
    Kt = g.setOptions;
    Wt = g.use;
    Xt = g.walkTokens;
    Jt = g.parseInline;
    Yt = b.parse;
    en = x.lex;
  }
});

// ../src/adapters/vcs/AdoProvider.ts
var AdoProvider_exports = {};
__export(AdoProvider_exports, {
  AdoProvider: () => AdoProvider
});
var AdoProvider;
var init_AdoProvider = __esm({
  "../src/adapters/vcs/AdoProvider.ts"() {
    "use strict";
    init_marked_esm();
    AdoProvider = class {
      organization;
      project;
      defaults;
      constructor(organization, project, defaults) {
        this.organization = organization;
        this.project = project;
        this.defaults = defaults;
      }
      async createWorkItem(title, body, labels, workItemType, adoOptions) {
        const token = this.getToken();
        if (!token) {
          throw new Error("ADO PAT token not found in environment variables");
        }
        try {
          const resolvedType = workItemType || this.defaults?.work_item_type || "User Story";
          const resolvedAreaPath = adoOptions?.area_path || this.defaults?.area_path;
          const resolvedIterationPath = adoOptions?.iteration_path || this.defaults?.iteration_path;
          const resolvedAssignedTo = adoOptions?.assigned_to || this.defaults?.assigned_to;
          const resolvedPriority = adoOptions?.priority;
          const resolvedParentId = adoOptions?.parent_id;
          const htmlBody = await g.parse(body);
          const autoTags = this.defaults?.auto_tags || [];
          const userTags = labels || [];
          const uniqueTags = [.../* @__PURE__ */ new Set([...userTags, ...autoTags, "optimus-bot"])];
          const patchDocument = [
            { op: "add", path: "/fields/System.Title", value: title },
            { op: "add", path: "/fields/System.Description", value: htmlBody }
          ];
          if (resolvedAreaPath) {
            patchDocument.push({ op: "add", path: "/fields/System.AreaPath", value: resolvedAreaPath });
          }
          if (resolvedIterationPath) {
            patchDocument.push({ op: "add", path: "/fields/System.IterationPath", value: resolvedIterationPath });
          }
          if (resolvedAssignedTo) {
            patchDocument.push({ op: "add", path: "/fields/System.AssignedTo", value: resolvedAssignedTo });
          }
          if (resolvedPriority !== void 0) {
            patchDocument.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: resolvedPriority });
          }
          if (uniqueTags.length > 0) {
            patchDocument.push({ op: "add", path: "/fields/System.Tags", value: uniqueTags.join("; ") });
          }
          if (resolvedParentId) {
            patchDocument.push({
              op: "add",
              path: "/relations/-",
              value: {
                rel: "System.LinkTypes.Hierarchy-Reverse",
                url: `https://dev.azure.com/${this.organization}/${this.project}/_apis/wit/workItems/${resolvedParentId}`,
                attributes: { comment: "Auto-linked by Optimus Swarm" }
              }
            });
          }
          const response = await fetch(
            `https://dev.azure.com/${this.organization}/${this.project}/_apis/wit/workitems/$${resolvedType}?api-version=7.0`,
            {
              method: "POST",
              headers: {
                "Authorization": `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
                "Content-Type": "application/json-patch+json",
                "Accept": "application/json",
                "User-Agent": "Optimus-Agent"
              },
              body: JSON.stringify(patchDocument)
            }
          );
          if (!response.ok) {
            throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
          }
          const data = await response.json();
          return {
            id: data.id.toString(),
            number: data.id,
            url: data._links.html.href,
            title: data.fields["System.Title"]
          };
        } catch (error) {
          throw new Error(`Failed to create ADO work item: ${error.message}`);
        }
      }
      async createPullRequest(title, body, head, base) {
        const token = this.getToken();
        if (!token) {
          throw new Error("ADO PAT token not found in environment variables");
        }
        try {
          const repoResponse = await fetch(
            `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories?api-version=7.0`,
            {
              headers: {
                "Authorization": `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
                "Accept": "application/json",
                "User-Agent": "Optimus-Agent"
              }
            }
          );
          if (!repoResponse.ok) {
            throw new Error(`Failed to get repository info: ${repoResponse.status}`);
          }
          const repos = await repoResponse.json();
          if (!repos.value || repos.value.length === 0) {
            throw new Error("No repositories found in the project");
          }
          const repositoryId = repos.value[0].id;
          const pullRequestData = {
            sourceRefName: `refs/heads/${head}`,
            targetRefName: `refs/heads/${base}`,
            title,
            description: body || "",
            reviewers: []
          };
          const response = await fetch(
            `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories/${repositoryId}/pullrequests?api-version=7.0`,
            {
              method: "POST",
              headers: {
                "Authorization": `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "Optimus-Agent"
              },
              body: JSON.stringify(pullRequestData)
            }
          );
          if (!response.ok) {
            throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
          }
          const data = await response.json();
          return {
            id: data.pullRequestId.toString(),
            number: data.pullRequestId,
            url: data._links.web.href,
            title: data.title
          };
        } catch (error) {
          throw new Error(`Failed to create ADO pull request: ${error.message}`);
        }
      }
      async mergePullRequest(pullRequestId, commitTitle, mergeMethod = "squash") {
        const token = this.getToken();
        if (!token) {
          throw new Error("ADO PAT token not found in environment variables");
        }
        try {
          const repoResponse = await fetch(
            `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories?api-version=7.0`,
            {
              headers: {
                "Authorization": `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
                "Accept": "application/json",
                "User-Agent": "Optimus-Agent"
              }
            }
          );
          if (!repoResponse.ok) {
            return { merged: false };
          }
          const repos = await repoResponse.json();
          if (!repos.value || repos.value.length === 0) {
            return { merged: false };
          }
          const repositoryId = repos.value[0].id;
          const prId = typeof pullRequestId === "string" ? parseInt(pullRequestId) : pullRequestId;
          let headBranch;
          let baseBranch;
          try {
            const prResponse = await fetch(
              `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories/${repositoryId}/pullrequests/${prId}?api-version=7.0`,
              {
                headers: {
                  "Authorization": `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
                  "Accept": "application/json",
                  "User-Agent": "Optimus-Agent"
                }
              }
            );
            if (prResponse.ok) {
              const prData = await prResponse.json();
              headBranch = prData.sourceRefName?.replace("refs/heads/", "");
              baseBranch = prData.targetRefName?.replace("refs/heads/", "");
            }
          } catch {
          }
          const mergeData = {
            status: "completed",
            completionOptions: {
              mergeStrategy: mergeMethod === "squash" ? "squashMerge" : "noFastForward",
              deleteSourceBranch: true
            }
          };
          if (commitTitle) {
            mergeData.completionOptions.mergeCommitMessage = commitTitle;
          }
          const response = await fetch(
            `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories/${repositoryId}/pullrequests/${prId}?api-version=7.0`,
            {
              method: "PATCH",
              headers: {
                "Authorization": `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "Optimus-Agent"
              },
              body: JSON.stringify(mergeData)
            }
          );
          return { merged: response.ok, headBranch, baseBranch };
        } catch {
          return { merged: false };
        }
      }
      async addComment(itemType, itemId, comment) {
        const token = this.getToken();
        if (!token) {
          throw new Error("ADO PAT token not found in environment variables");
        }
        const id = typeof itemId === "string" ? parseInt(itemId) : itemId;
        try {
          if (itemType === "workitem") {
            const response = await fetch(
              `https://dev.azure.com/${this.organization}/${this.project}/_apis/wit/workItems/${id}/comments?api-version=7.0`,
              {
                method: "POST",
                headers: {
                  "Authorization": `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
                  "Content-Type": "application/json",
                  "Accept": "application/json",
                  "User-Agent": "Optimus-Agent"
                },
                body: JSON.stringify({ text: comment })
              }
            );
            if (!response.ok) {
              throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
            }
            const data = await response.json();
            return {
              id: data.id.toString(),
              url: data.url || `https://dev.azure.com/${this.organization}/${this.project}/_workitems/edit/${id}`
            };
          } else {
            const repoResponse = await fetch(
              `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories?api-version=7.0`,
              {
                headers: {
                  "Authorization": `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
                  "Accept": "application/json",
                  "User-Agent": "Optimus-Agent"
                }
              }
            );
            if (!repoResponse.ok) {
              throw new Error("Failed to get repository info");
            }
            const repos = await repoResponse.json();
            const repositoryId = repos.value[0].id;
            const response = await fetch(
              `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories/${repositoryId}/pullRequests/${id}/threads?api-version=7.0`,
              {
                method: "POST",
                headers: {
                  "Authorization": `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
                  "Content-Type": "application/json",
                  "Accept": "application/json",
                  "User-Agent": "Optimus-Agent"
                },
                body: JSON.stringify({
                  comments: [{
                    parentCommentId: 0,
                    content: comment,
                    commentType: "text"
                  }],
                  status: "active"
                })
              }
            );
            if (!response.ok) {
              throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
            }
            const data = await response.json();
            return {
              id: data.id.toString(),
              url: `https://dev.azure.com/${this.organization}/${this.project}/_git/pullrequest/${id}`
            };
          }
        } catch (error) {
          throw new Error(`Failed to add ADO comment: ${error.message}`);
        }
      }
      getProviderName() {
        return "azure-devops";
      }
      getToken() {
        return process.env.ADO_PAT || process.env.AZURE_DEVOPS_PAT;
      }
    };
  }
});

// ../src/mcp/mcp-server.ts
var import_server = require("@modelcontextprotocol/sdk/server/index.js");
var import_stdio = require("@modelcontextprotocol/sdk/server/stdio.js");
var import_types = require("@modelcontextprotocol/sdk/types.js");
var import_fs3 = __toESM(require("fs"));
var import_path3 = __toESM(require("path"));
var import_crypto = __toESM(require("crypto"));

// ../src/mcp/worker-spawner.ts
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));

// ../src/constants.ts
var MAX_DELEGATION_DEPTH = 3;

// ../src/adapters/PersistentAgentAdapter.ts
var cp = __toESM(require("child_process"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var import_strip_ansi = __toESM(require("strip-ansi"));
var iconv = __toESM(require("iconv-lite"));

// ../src/debugLogger.ts
var customLogger;
var cachedDebugMode = process.env.OPTIMUS_DEBUG === "1";
function isDebugModeEnabled() {
  return cachedDebugMode;
}
function debugLog(scope, message, details) {
  if (!isDebugModeEnabled()) {
    return;
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  let logMessage = `[${timestamp}] [${scope}] ${message}`;
  if (details) {
    logMessage += `
${details}`;
  }
  if (customLogger) {
    customLogger(logMessage);
  } else {
    console.error(logMessage);
  }
}
function formatChunk(chunk, maxLength = 800) {
  const normalized = chunk.replace(/\r/g, "\\r").replace(/\n/g, "\\n\n");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength) + "... [truncated]";
}

// ../src/utils/textParsing.ts
var ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// ../src/adapters/PersistentAgentAdapter.ts
var windowsSpawnResolutionCache = /* @__PURE__ */ new Map();
var DEFAULT_PROMPT_FILE_THRESHOLD = 12e3;
var MAX_OUTPUT_BUFFER_BYTES = 10 * 1024 * 1024;
function decodeBuffer(buf) {
  if (process.platform === "win32") {
    const utf8Text = buf.toString("utf8");
    if (!utf8Text.includes("\uFFFD")) {
      return utf8Text;
    }
    return iconv.decode(buf, "cp936");
  }
  return buf.toString("utf8");
}
function resolveWindowsSpawnResolution(cmd) {
  const cached = windowsSpawnResolutionCache.get(cmd);
  if (cached !== void 0) {
    return cached;
  }
  const whereResult = cp.spawnSync("where.exe", [cmd], { encoding: "utf8" });
  if (whereResult.status !== 0 || !whereResult.stdout) {
    windowsSpawnResolutionCache.set(cmd, null);
    return null;
  }
  const candidates = whereResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((candidate) => fs.existsSync(candidate)).sort((left, right) => {
    const extRank = (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".exe" || ext === ".com") {
        return 0;
      }
      if (ext === ".cmd") {
        return 1;
      }
      if (ext === ".bat") {
        return 2;
      }
      return 3;
    };
    return extRank(left) - extRank(right);
  });
  for (const candidate of candidates) {
    const ext = path.extname(candidate).toLowerCase();
    if (ext === ".exe" || ext === ".com") {
      const resolved = { cmd: candidate, argsPrefix: [] };
      windowsSpawnResolutionCache.set(cmd, resolved);
      return resolved;
    }
    if (ext !== ".cmd") {
      continue;
    }
    try {
      const wrapperText = fs.readFileSync(candidate, "utf8");
      const scriptMatch = wrapperText.match(/"%dp0%\\([^\"]+?\.js)"/i);
      if (!scriptMatch) {
        continue;
      }
      const wrapperDir = path.dirname(candidate);
      const nodeExecutable = fs.existsSync(path.join(wrapperDir, "node.exe")) ? path.join(wrapperDir, "node.exe") : "node";
      const entryScript = path.join(wrapperDir, scriptMatch[1].replace(/\\/g, path.sep));
      const resolved = { cmd: nodeExecutable, argsPrefix: [entryScript] };
      windowsSpawnResolutionCache.set(cmd, resolved);
      return resolved;
    } catch {
      continue;
    }
  }
  windowsSpawnResolutionCache.set(cmd, null);
  return null;
}
function platformSpawn(cmd, args, options) {
  options = { ...options, windowsHide: true };
  if (process.platform === "win32") {
    const resolved = resolveWindowsSpawnResolution(cmd);
    if (resolved) {
      return cp.spawn(resolved.cmd, [...resolved.argsPrefix, ...args], options);
    }
    return cp.spawn("cmd", ["/c", cmd, ...args], options);
  }
  return cp.spawn(cmd, args, options);
}
var PersistentAgentAdapter = class _PersistentAgentAdapter {
  static workspacePathHint = null;
  static setWorkspacePathHint(hint) {
    _PersistentAgentAdapter.workspacePathHint = hint;
  }
  static resolveWorkspacePath() {
    if (process.env.OPTIMUS_WORKSPACE) {
      return { path: process.env.OPTIMUS_WORKSPACE, source: "process.env.OPTIMUS_WORKSPACE" };
    }
    if (_PersistentAgentAdapter.workspacePathHint) {
      return { path: _PersistentAgentAdapter.workspacePathHint, source: "workspacePathHint" };
    }
    debugLog("PersistentAgentAdapter", "WARNING: workspace path resolved via process.cwd() fallback \u2014 .optimus/ artifacts may land outside the active project. Set OPTIMUS_WORKSPACE or ensure the extension activates with a workspace folder.", JSON.stringify({ cwd: process.cwd() }));
    return { path: process.cwd(), source: "process.cwd()" };
  }
  id;
  name;
  modelFlag;
  isEnabled = true;
  modes = ["plan", "agent"];
  lastDebugInfo;
  lastUsageLog;
  lastSessionId;
  childProcess = null;
  promptString;
  outputBuffer = "";
  currentMode = "plan";
  currentTurnMarker = null;
  turnResolve = null;
  turnReject = null;
  turnOnUpdate = null;
  constructor(id, name, modelFlag = "", promptString, modes) {
    this.id = id;
    this.name = name;
    this.modelFlag = modelFlag;
    this.promptString = promptString;
    if (modes) {
      this.modes = modes;
    }
  }
  /**
   * Returns the active workspace folder path, with robust fallback.
   */
  static getWorkspacePath() {
    return _PersistentAgentAdapter.resolveWorkspacePath().path;
  }
  /**
   * Hook for subclasses to sanitize spawn environment variables.
   * E.g., Copilot adapter strips GITHUB_TOKEN to prevent auth shadowing.
   */
  sanitizeSpawnEnv(_env) {
  }
  shouldUseStructuredOutput(mode) {
    return false;
  }
  shouldUsePersistentSession(mode) {
    return mode === "agent";
  }
  getPromptFileThreshold() {
    const configured = Number(process.env.OPTIMUS_PROMPT_FILE_THRESHOLD);
    if (!process.env.OPTIMUS_PROMPT_FILE_THRESHOLD || !Number.isFinite(configured)) {
      return DEFAULT_PROMPT_FILE_THRESHOLD;
    }
    return Math.max(1e3, Math.floor(configured));
  }
  shouldUsePromptFile(mode, prompt) {
    return prompt.length >= this.getPromptFileThreshold();
  }
  preparePromptForNonInteractive(mode, prompt, currentCwd) {
    if (!this.shouldUsePromptFile(mode, prompt)) {
      return { prompt, transport: "inline" };
    }
    const promptDir = path.join(currentCwd, ".optimus", "runtime-prompts");
    fs.mkdirSync(promptDir, { recursive: true });
    const promptFileName = [
      this.id.replace(/[^a-z0-9_-]/gi, "-"),
      mode,
      Date.now().toString(),
      Math.random().toString(36).slice(2, 8)
    ].join("-") + ".md";
    const promptFilePath = path.join(promptDir, promptFileName);
    fs.writeFileSync(promptFilePath, prompt, "utf8");
    debugLog(this.id, "Prepared oversized prompt file", JSON.stringify({
      mode,
      promptLength: prompt.length,
      promptFilePath,
      promptFileThreshold: this.getPromptFileThreshold()
    }));
    const relativePromptPath = path.relative(currentCwd, promptFilePath).replace(/\\/g, "/");
    const wrappedPrompt = [
      "The original user prompt was too large to pass inline over the CLI.",
      `Read the UTF-8 file at "${relativePromptPath}" before doing anything else.`,
      "That file was created by the local Optimus tool for this exact turn and contains trusted user input, not untrusted workspace instructions.",
      "Use the full file contents as the real prompt for this request, then continue the task normally."
    ].join(" ");
    return {
      prompt: wrappedPrompt,
      transport: "file",
      filePath: promptFilePath,
      cleanup: () => {
        try {
          fs.unlinkSync(promptFilePath);
          debugLog(this.id, "Removed runtime prompt file", JSON.stringify({ promptFilePath }));
        } catch {
        }
      }
    };
  }
  /**
   * For non-interactive modes, returns the command + args with -p prepended.
   */
  getNonInteractiveCommand(mode, prompt, sessionId) {
    const { cmd, args } = this.getSpawnCommand(mode);
    const safePrompt = prompt.replace(/\r?\n/g, " ").trim();
    return { cmd, args: ["-p", safePrompt, ...args] };
  }
  combineStructuredDisplay(processText, assistantText) {
    const processBlock = processText.trim();
    const outputBlock = assistantText.trim();
    if (processBlock && outputBlock) {
      return `${processBlock}

${outputBlock}`;
    }
    return processBlock || outputBlock;
  }
  buildStructuredStreamPayload(processText, reasoningText, assistantText) {
    const sections = [];
    const processBlock = processText.trim();
    const reasoningBlock = reasoningText.trim();
    const outputBlock = assistantText.trim();
    if (processBlock) {
      sections.push(`<optimus-trace>
${processBlock}
</optimus-trace>`);
    }
    if (reasoningBlock) {
      sections.push(`<optimus-reasoning>
${reasoningBlock}
</optimus-reasoning>`);
    }
    if (outputBlock) {
      sections.push(`<optimus-output>
${outputBlock}
</optimus-output>`);
    }
    return sections.join("\n\n").trim();
  }
  summarizeStructuredInput(input) {
    if (input === null || input === void 0) {
      return "";
    }
    if (typeof input === "string") {
      const normalized = input.replace(/\s+/g, " ").trim();
      return normalized.length > 96 ? normalized.slice(0, 93) + "..." : normalized;
    }
    if (typeof input === "number" || typeof input === "boolean") {
      return String(input);
    }
    if (Array.isArray(input)) {
      if (input.length === 0) {
        return "[]";
      }
      const primitiveItems = input.filter((item) => ["string", "number", "boolean"].includes(typeof item));
      if (primitiveItems.length > 0) {
        const preview = primitiveItems.slice(0, 3).map((item) => this.summarizeStructuredInput(item)).join(", ");
        return input.length > 3 ? `${preview}, ... (${input.length} items)` : preview;
      }
      return `${input.length} items`;
    }
    const preferredKeys = [
      "role_prompt",
      "engine",
      "model",
      "instruction",
      "workdir",
      "file_path",
      "path",
      "relative_workspace_path",
      "start_line",
      "end_line",
      "startLine",
      "endLine",
      "line",
      "insert_line",
      "command",
      "query",
      "pattern",
      "symbol",
      "url",
      "name",
      "description",
      "task",
      "includePattern",
      "filePath",
      "input"
    ];
    const parts = [];
    for (const key of preferredKeys) {
      if (!(key in input)) {
        continue;
      }
      const value = input[key];
      const summary = this.summarizeStructuredInput(value);
      if (summary) {
        parts.push(`${key}=${summary}`);
      }
      if (parts.length >= 4) {
        break;
      }
    }
    if (parts.length === 0) {
      const keys = Object.keys(input);
      if (keys.length === 0) {
        return "{}";
      }
      return keys.slice(0, 3).join(", ");
    }
    return parts.join(", ");
  }
  formatStructuredToolCall(toolName, input) {
    const normalizedName = toolName.trim() || "tool";
    const summary = this.summarizeStructuredInput(input);
    return summary ? `\u2022 ${normalizedName}
\u21B3 ${summary}` : `\u2022 ${normalizedName}`;
  }
  appendProcessLines(currentText, lines) {
    const existingLines = currentText ? currentText.split("\n").filter(Boolean) : [];
    for (const line of lines) {
      for (const subLine of line.split("\n").map((l) => l.trim()).filter(Boolean)) {
        if (existingLines[existingLines.length - 1] === subLine) {
          continue;
        }
        existingLines.push(subLine);
      }
    }
    return existingLines.join("\n");
  }
  registerStructuredToolCall(toolCalls, toolCallId, toolName, input) {
    if (!toolCallId) {
      return;
    }
    toolCalls.set(toolCallId, { name: toolName, input });
  }
  summarizeStructuredToolResult(result) {
    if (result === null || result === void 0) {
      return "";
    }
    if (typeof result === "string") {
      const nonEmptyLines = result.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== "[LOG]");
      if (nonEmptyLines.length === 0) {
        return "empty result";
      }
      const preview = nonEmptyLines[0].replace(/\s+/g, " ").trim();
      if (nonEmptyLines.length === 1) {
        return preview.length > 96 ? preview.slice(0, 93) + "..." : preview;
      }
      const lineCount = `${nonEmptyLines.length} lines`;
      const clippedPreview = preview.length > 72 ? preview.slice(0, 69) + "..." : preview;
      return `${lineCount}, preview=${clippedPreview}`;
    }
    if (typeof result === "number" || typeof result === "boolean") {
      return String(result);
    }
    if (Array.isArray(result)) {
      if (result.length === 0) {
        return "0 items";
      }
      return `${result.length} items`;
    }
    const record = result;
    if (typeof record.stdout === "string" && record.stdout.trim()) {
      return this.summarizeStructuredToolResult(record.stdout);
    }
    if (typeof record.content === "string" && record.content.trim()) {
      return this.summarizeStructuredToolResult(record.content);
    }
    if (typeof record.detailedContent === "string" && record.detailedContent.trim()) {
      return this.summarizeStructuredToolResult(record.detailedContent);
    }
    if (typeof record.stderr === "string" && record.stderr.trim()) {
      return `stderr=${this.summarizeStructuredToolResult(record.stderr)}`;
    }
    const keys = Object.keys(record);
    return keys.length > 0 ? keys.slice(0, 4).join(", ") : "object result";
  }
  countMeaningfulLines(value) {
    return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== "[LOG]");
  }
  looksLikePathList(lines) {
    if (lines.length === 0) {
      return false;
    }
    const sample = lines.slice(0, Math.min(lines.length, 6));
    return sample.every((line) => !/\s{2,}/.test(line) && !/[{}<>]/.test(line));
  }
  sanitizeStructuredSummaryValue(value, maxLength = 96) {
    return value.replace(/\s+/g, " ").replace(/,\s*/g, "; ").trim().slice(0, maxLength);
  }
  getStructuredResultText(record, result) {
    const candidateKeys = ["content", "stdout", "text", "output", "detailedContent", "message"];
    for (const key of candidateKeys) {
      const value = record?.[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
    return typeof result === "string" ? result : "";
  }
  getStructuredResultPath(record) {
    const candidateKeys = ["file_path", "filepath", "path", "relative_workspace_path", "target_file", "targetPath"];
    for (const key of candidateKeys) {
      const value = record?.[key];
      if (typeof value === "string" && value.trim()) {
        return this.sanitizeStructuredSummaryValue(value, 120);
      }
    }
    return void 0;
  }
  getStructuredResultLineRange(record) {
    const start = typeof record?.start_line === "number" ? record.start_line : typeof record?.startLine === "number" ? record.startLine : void 0;
    const end = typeof record?.end_line === "number" ? record.end_line : typeof record?.endLine === "number" ? record.endLine : void 0;
    const insertLine = typeof record?.insert_line === "number" ? record.insert_line : typeof record?.insertLine === "number" ? record.insertLine : void 0;
    if (typeof start === "number" && typeof end === "number") {
      return `lines=${start}-${end}`;
    }
    if (typeof start === "number") {
      return `line=${start}`;
    }
    if (typeof insertLine === "number") {
      return `line=${insertLine}`;
    }
    return void 0;
  }
  buildStructuredSummary(parts) {
    return parts.filter((part) => Boolean(part && part.trim())).join(", ");
  }
  summarizeToolResultByName(toolName, result) {
    const normalizedName = toolName.toLowerCase();
    const record = typeof result === "object" && result !== null ? result : void 0;
    const content = this.getStructuredResultText(record, result);
    const lines = this.countMeaningfulLines(content);
    const path8 = this.getStructuredResultPath(record);
    const lineRange = this.getStructuredResultLineRange(record);
    const preview = lines.length > 0 ? `preview=${this.sanitizeStructuredSummaryValue(lines[0], 80)}` : void 0;
    if (/delegate_task/.test(normalizedName)) {
      const cleanedLines = lines.filter((line) => !/^Worker output:/i.test(line) && !/^\[Session:/i.test(line) && !/^\[In:/i.test(line));
      if (cleanedLines.length === 0) {
        return "worker completed";
      }
      const firstLine = this.sanitizeStructuredSummaryValue(cleanedLines[0], 120);
      if (cleanedLines.length === 1) {
        return `worker=${firstLine}`;
      }
      return `worker=${firstLine}, lines=${cleanedLines.length}`;
    }
    if (/bash|shell|run|exec|command/.test(normalizedName)) {
      const stdout = typeof record?.stdout === "string" ? record.stdout : content;
      const stderr = typeof record?.stderr === "string" ? record.stderr : "";
      const stdoutLines = this.countMeaningfulLines(stdout);
      const stderrLines = this.countMeaningfulLines(stderr);
      const exitCode = typeof record?.exit_code === "number" ? record.exit_code : typeof record?.exitCode === "number" ? record.exitCode : void 0;
      const segments = [`stdout=${stdoutLines.length > 0 ? `${stdoutLines.length} lines` : "empty"}`];
      if (typeof exitCode === "number") {
        segments.push(`exit=${exitCode}`);
      }
      if (stderrLines.length > 0) {
        segments.push(`stderr=${stderrLines.length} lines`);
      }
      if (stdoutLines.length > 0) {
        segments.push(`preview=${this.sanitizeStructuredSummaryValue(stdoutLines[0], 80)}`);
      }
      return segments.join(", ");
    }
    if (/grep|search/.test(normalizedName)) {
      if (lines.length === 0) {
        return this.buildStructuredSummary([path8, "matches=0"]);
      }
      return this.buildStructuredSummary([path8, `matches=${lines.length}`, preview]);
    }
    if (/edit|write|create|update|patch|save|insert/.test(normalizedName)) {
      if (lines.length === 0) {
        return this.buildStructuredSummary([path8, lineRange, "status=updated"]);
      }
      return this.buildStructuredSummary([path8, lineRange, `lines=${lines.length}`, preview]);
    }
    if (/read|view/.test(normalizedName)) {
      if (lines.length === 0) {
        return this.buildStructuredSummary([path8, lineRange, "lines=0"]);
      }
      return this.buildStructuredSummary([path8, lineRange, `lines=${lines.length}`, preview]);
    }
    if (/glob|list|ls|dir/.test(normalizedName)) {
      if (lines.length === 0) {
        return this.buildStructuredSummary([path8, "items=0"]);
      }
      if (this.looksLikePathList(lines)) {
        return this.buildStructuredSummary([path8, `items=${lines.length}`, `first=${this.sanitizeStructuredSummaryValue(lines[0], 80)}`]);
      }
      return this.buildStructuredSummary([path8, `lines=${lines.length}`, preview]);
    }
    return this.summarizeStructuredToolResult(result);
  }
  formatStructuredToolCompletion(toolName, result, success = true) {
    const summary = this.summarizeToolResultByName(toolName, result);
    const lines = [`${success ? "\u2713" : "\u2717"} ${toolName.trim() || "tool"}`];
    if (summary) {
      lines.push(`\u21B3 result=${summary}`);
    }
    return lines;
  }
  extractThinkingWithSharedParser(rawText, options) {
    if (!rawText) {
      return { thinking: "", output: "" };
    }
    const tagRegex = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
    const thinkingBlocks = [];
    const logLines = [];
    let remaining = rawText;
    let match;
    while ((match = tagRegex.exec(rawText)) !== null) {
      thinkingBlocks.push(match[2].trim());
      remaining = remaining.replace(match[0], "");
    }
    const lines = remaining.split(/\r?\n|\r/);
    const processLines = [];
    const outputLines = [];
    let outputStarted = false;
    const isProcessLine = (clean) => {
      if (!clean) {
        return true;
      }
      if (options.processLineRe.test(clean)) {
        return true;
      }
      if (clean.startsWith("> [")) {
        return true;
      }
      if (options.captureBracketLines && clean.startsWith("[")) {
        return true;
      }
      return false;
    };
    for (const line of lines) {
      const clean = line.replace(ANSI_RE, "").trim();
      if (options.collectUsageLog && /\[LOG\]/i.test(clean)) {
        logLines.push(clean);
        continue;
      }
      if (!outputStarted) {
        if (isProcessLine(clean)) {
          processLines.push(line);
        } else {
          outputStarted = true;
          outputLines.push(line);
        }
      } else if (options.captureProcessLinesAfterOutputStarts && isProcessLine(clean) && clean !== "") {
        processLines.push(line);
      } else {
        outputLines.push(line);
      }
    }
    while (processLines.length > 0 && processLines[processLines.length - 1].trim() === "") {
      outputLines.unshift(processLines.pop());
    }
    const processBlock = processLines.join("\n").trim();
    if (processBlock) {
      thinkingBlocks.push("```text\n" + processBlock + "\n```");
    }
    return {
      thinking: thinkingBlocks.join("\n\n---\n\n"),
      output: outputLines.join("\n").trim(),
      usageLog: logLines.length > 0 ? logLines.join("\n") : this.lastUsageLog
    };
  }
  buildTurnCompletionMarker() {
    return `[[OPTIMUS_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}]]`;
  }
  stripTurnCompletionArtifacts(text) {
    let cleaned = text;
    if (this.currentTurnMarker) {
      cleaned = cleaned.replace(this.currentTurnMarker, "");
    }
    return cleaned.trim();
  }
  /**
   * One-shot execution using -p flag. Spawns a process, collects all output, resolves when done.
   */
  invokeNonInteractive(prompt, mode, sessionId, onUpdate, extraEnv) {
    return new Promise((resolve, reject) => {
      const workspacePath = _PersistentAgentAdapter.resolveWorkspacePath();
      const currentCwd = workspacePath.path;
      const preparedPrompt = this.preparePromptForNonInteractive(mode, prompt, currentCwd);
      const promptFileThreshold = this.getPromptFileThreshold();
      const { cmd, args } = this.getNonInteractiveCommand(mode, preparedPrompt.prompt, sessionId);
      if (extraEnv?.OPTIMUS_DELEGATION_DEPTH) {
        const depth = parseInt(extraEnv.OPTIMUS_DELEGATION_DEPTH, 10);
        if (depth >= MAX_DELEGATION_DEPTH) {
          const mcpIdx = args.findIndex((a) => a === "--mcp-config" || a.startsWith("--mcp-config="));
          if (mcpIdx !== -1) {
            args.splice(mcpIdx, args[mcpIdx].includes("=") ? 1 : 2);
          }
        }
      }
      const useStructuredOutput = this.shouldUseStructuredOutput(mode);
      this.lastUsageLog = void 0;
      debugLog(this.id, "Starting non-interactive invoke", JSON.stringify({
        mode,
        cwd: currentCwd,
        cwdSource: workspacePath.source,
        cmd,
        args: args.map((a, i) => i === 0 ? a : `[${a.length} chars]`),
        promptLength: prompt.length,
        sentPromptLength: preparedPrompt.prompt.length,
        promptTransport: preparedPrompt.transport,
        promptFilePath: preparedPrompt.filePath,
        promptFileThreshold
      }));
      let output = "";
      let structuredBuffer = "";
      let structuredProcessText = "";
      let structuredReasoningText = "";
      let structuredAssistantText = "";
      let structuredResultText = "";
      const structuredToolCalls = /* @__PURE__ */ new Map();
      const startTime = Date.now();
      let stallWarningTimer = null;
      const safeEnv = { ...process.env, TERM: "dumb", CI: "false", FORCE_COLOR: "0", ...extraEnv || {} };
      if (process.platform === "win32" && !safeEnv.CLAUDE_CODE_GIT_BASH_PATH) {
        safeEnv.CLAUDE_CODE_GIT_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe";
      }
      this.sanitizeSpawnEnv(safeEnv);
      const child = platformSpawn(cmd, args, {
        cwd: currentCwd,
        env: safeEnv
      });
      this.lastDebugInfo = {
        command: cmd + " " + args.join(" "),
        cwd: currentCwd,
        pid: child.pid || 0,
        startTime,
        promptTransport: preparedPrompt.transport,
        promptFilePath: preparedPrompt.filePath,
        originalPromptLength: prompt.length,
        sentPromptLength: preparedPrompt.prompt.length,
        promptFileThreshold
      };
      child.stdin.end();
      debugLog(this.id, "Closed stdin for non-interactive invoke");
      stallWarningTimer = setTimeout(() => {
        debugLog(this.id, "Non-interactive invoke still running after threshold", JSON.stringify({
          mode,
          thresholdMs: 15e3,
          pid: child.pid,
          cwd: currentCwd,
          outputLength: output.length
        }));
      }, 15e3);
      child.stdout.on("data", (data) => {
        const chunk = (0, import_strip_ansi.default)(decodeBuffer(data));
        debugLog(this.id, "stdout chunk", formatChunk(chunk));
        if (useStructuredOutput) {
          structuredBuffer += chunk;
          const lines = structuredBuffer.split(/\r?\n/);
          structuredBuffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }
            try {
              const event = JSON.parse(trimmed);
              const nextProcessText = this.applyStructuredProcessEvent(structuredProcessText, event, structuredToolCalls);
              const hasProcessUpdate = nextProcessText !== structuredProcessText;
              if (hasProcessUpdate) {
                structuredProcessText = nextProcessText;
              }
              const nextStreamingText = this.applyStructuredStreamingEvent(structuredAssistantText, event);
              const hasAssistantUpdate = nextStreamingText !== structuredAssistantText;
              if (hasAssistantUpdate) {
                structuredAssistantText = nextStreamingText;
              }
              const nextReasoningText = this.applyStructuredReasoningEvent(structuredReasoningText, event);
              const hasReasoningUpdate = nextReasoningText !== structuredReasoningText;
              if (hasReasoningUpdate) {
                structuredReasoningText = nextReasoningText;
              }
              if ((hasProcessUpdate || hasReasoningUpdate || hasAssistantUpdate) && onUpdate) {
                onUpdate(this.buildStructuredStreamPayload(structuredProcessText, structuredReasoningText, structuredAssistantText));
              }
              if (event?.type === "result") {
                const resultText = typeof event.result === "string" ? event.result : "";
                if (resultText) {
                  structuredResultText = resultText;
                }
                this.lastUsageLog = this.extractStructuredUsageLog(event) || this.lastUsageLog;
              }
              if (event?.session_id || event?.sessionId) {
                this.lastSessionId = event.session_id || event.sessionId;
              }
            } catch {
              output += chunk;
              if (onUpdate) {
                onUpdate(output.trim());
              }
              break;
            }
          }
        } else {
          output += chunk;
          if (onUpdate) {
            onUpdate(output.trim());
          }
        }
        const sessionMatch = chunk.match(/"?(?:session_id|sessionId)"?\s*[:=]\s*"([0-9a-f-]{36})"/i);
        if (sessionMatch) {
          this.lastSessionId = sessionMatch[1];
        }
      });
      child.stderr.on("data", (data) => {
        const chunk = (0, import_strip_ansi.default)(decodeBuffer(data));
        debugLog(this.id, "stderr chunk", formatChunk(chunk));
        output += "\n> [LOG] " + chunk;
      });
      child.on("error", (err) => {
        preparedPrompt.cleanup?.();
        if (stallWarningTimer) {
          clearTimeout(stallWarningTimer);
          stallWarningTimer = null;
        }
        if (this.childProcess === child) {
          this.childProcess = null;
        }
        debugLog(this.id, "Process error during non-interactive invoke", err.stack || String(err));
        reject(err);
      });
      child.on("close", (code) => {
        preparedPrompt.cleanup?.();
        if (stallWarningTimer) {
          clearTimeout(stallWarningTimer);
          stallWarningTimer = null;
        }
        if (this.childProcess === child) {
          this.childProcess = null;
        }
        if (this.lastDebugInfo) {
          this.lastDebugInfo.endTime = Date.now();
        }
        debugLog(this.id, "Non-interactive process closed", JSON.stringify({
          code,
          duration: this.lastDebugInfo?.endTime && this.lastDebugInfo?.startTime ? this.lastDebugInfo.endTime - this.lastDebugInfo.startTime : void 0,
          outputLength: output.trim().length,
          promptTransport: this.lastDebugInfo?.promptTransport,
          promptFilePath: this.lastDebugInfo?.promptFilePath
        }));
        if (useStructuredOutput && structuredBuffer.trim()) {
          try {
            const event = JSON.parse(structuredBuffer.trim());
            structuredProcessText = this.applyStructuredProcessEvent(structuredProcessText, event, structuredToolCalls);
            structuredReasoningText = this.applyStructuredReasoningEvent(structuredReasoningText, event);
            structuredAssistantText = this.applyStructuredStreamingEvent(structuredAssistantText, event);
            if (event?.type === "result" && typeof event.result === "string") {
              structuredResultText = event.result;
            }
            this.lastUsageLog = this.extractStructuredUsageLog(event) || this.lastUsageLog;
          } catch {
            output += structuredBuffer;
          }
        }
        const finalOutput = useStructuredOutput ? this.combineStructuredDisplay(structuredProcessText, structuredResultText.trim() || structuredAssistantText.trim() || output.trim()).trim() : output.trim();
        if (code !== 0 && !finalOutput) {
          reject(new Error(`Process exited with code ${code}`));
        } else {
          resolve(finalOutput);
        }
      });
      this.childProcess = child;
    });
  }
  extractStructuredAssistantText(event) {
    if (event?.type === "assistant.message" && typeof event?.data?.content === "string") {
      return event.data.content;
    }
    const content = event?.message?.content;
    if (!Array.isArray(content)) {
      return typeof event?.text === "string" ? event.text : "";
    }
    return content.map((block) => {
      if (block?.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  applyStructuredProcessEvent(currentText, event, toolCalls) {
    if (event?.type === "assistant") {
      const content = event?.message?.content;
      if (!Array.isArray(content)) {
        return currentText;
      }
      const lines = content.map((block) => {
        if (block?.type !== "tool_use") {
          return "";
        }
        const toolName = typeof block.name === "string" ? block.name : "tool";
        this.registerStructuredToolCall(toolCalls, typeof block.id === "string" ? block.id : void 0, toolName, block.input);
        return this.formatStructuredToolCall(toolName, block.input);
      }).filter(Boolean);
      return this.appendProcessLines(currentText, lines);
    }
    if (event?.type === "assistant.message") {
      const toolRequests = Array.isArray(event?.data?.toolRequests) ? event.data.toolRequests : [];
      const lines = toolRequests.map((request) => {
        const toolName = typeof request?.name === "string" ? request.name : "tool";
        const toolCallId = typeof request?.toolCallId === "string" ? request.toolCallId : void 0;
        this.registerStructuredToolCall(toolCalls, toolCallId, toolName, request?.arguments);
        return this.formatStructuredToolCall(toolName, request?.arguments);
      });
      return this.appendProcessLines(currentText, lines);
    }
    if (event?.type === "tool.execution_start") {
      const toolCallId = typeof event?.data?.toolCallId === "string" ? event.data.toolCallId : void 0;
      const toolName = typeof event?.data?.toolName === "string" ? event.data.toolName : "tool";
      const alreadyRegistered = toolCallId ? toolCalls.has(toolCallId) : false;
      this.registerStructuredToolCall(toolCalls, toolCallId, toolName, event?.data?.arguments);
      if (alreadyRegistered) {
        return currentText;
      }
      return this.appendProcessLines(currentText, [this.formatStructuredToolCall(toolName, event?.data?.arguments)]);
    }
    if (event?.type === "tool.execution_complete") {
      const toolCallId = typeof event?.data?.toolCallId === "string" ? event.data.toolCallId : void 0;
      const toolName = typeof event?.data?.toolName === "string" ? event.data.toolName : toolCallId && toolCalls.get(toolCallId)?.name || "tool";
      const success = event?.data?.success !== false;
      return this.appendProcessLines(currentText, this.formatStructuredToolCompletion(toolName, event?.data?.result, success));
    }
    if (event?.type === "user") {
      const toolResultBlocks = Array.isArray(event?.message?.content) ? event.message.content.filter((block) => block?.type === "tool_result") : [];
      if (toolResultBlocks.length === 0) {
        return currentText;
      }
      let updatedText = currentText;
      for (const block of toolResultBlocks) {
        const toolCallId = typeof block?.tool_use_id === "string" ? block.tool_use_id : void 0;
        if (!toolCallId) {
          continue;
        }
        const toolName = toolCalls.get(toolCallId)?.name || "tool";
        const success = block?.is_error !== true;
        const result = block?.content;
        updatedText = this.appendProcessLines(updatedText, this.formatStructuredToolCompletion(toolName, result, success));
      }
      return updatedText;
    }
    if (event?.type === "stream_event") {
      const innerEvent = event.event;
      if (innerEvent?.type === "content_block_start" && innerEvent.content_block?.type === "tool_use") {
        const toolName = typeof innerEvent.content_block.name === "string" ? innerEvent.content_block.name : "tool";
        this.registerStructuredToolCall(
          toolCalls,
          typeof innerEvent.content_block.id === "string" ? innerEvent.content_block.id : void 0,
          toolName,
          innerEvent.content_block.input
        );
        return this.appendProcessLines(currentText, [
          this.formatStructuredToolCall(toolName, innerEvent.content_block.input)
        ]);
      }
    }
    return currentText;
  }
  applyStructuredStreamingEvent(currentText, event) {
    if (event?.type === "assistant.message_delta" && typeof event?.data?.deltaContent === "string") {
      return currentText + event.data.deltaContent;
    }
    if (event?.type === "assistant.message" && typeof event?.data?.content === "string") {
      return this.mergeStreamingText(currentText, event.data.content);
    }
    if (event?.type === "assistant") {
      const nextAssistantText = this.extractStructuredAssistantText(event);
      return nextAssistantText ? this.mergeStreamingText(currentText, nextAssistantText) : currentText;
    }
    if (event?.type === "stream_event") {
      const innerEvent = event.event;
      if (innerEvent?.type === "content_block_delta" && innerEvent.delta?.type === "text_delta" && typeof innerEvent.delta.text === "string") {
        return currentText + innerEvent.delta.text;
      }
    }
    return currentText;
  }
  applyStructuredReasoningEvent(currentText, event) {
    if (event?.type === "assistant.reasoning_delta" && typeof event?.data?.deltaContent === "string") {
      return currentText + event.data.deltaContent;
    }
    if (event?.type === "assistant.reasoning" && typeof event?.data?.content === "string") {
      return this.mergeStreamingText(currentText, event.data.content);
    }
    if (event?.type === "assistant.message" && typeof event?.data?.reasoningText === "string") {
      return this.mergeStreamingText(currentText, event.data.reasoningText);
    }
    return currentText;
  }
  mergeStreamingText(currentText, nextText) {
    if (!currentText) {
      return nextText;
    }
    if (!nextText) {
      return currentText;
    }
    if (nextText.startsWith(currentText)) {
      return nextText;
    }
    if (currentText.endsWith(nextText)) {
      return currentText;
    }
    return currentText + nextText;
  }
  extractStructuredUsageLog(event) {
    return void 0;
  }
  /**
   * Interactive daemon initialization for agent mode.
   */
  async initialize(mode) {
    if (this.childProcess) {
      if (this.currentMode !== mode) {
        debugLog(this.id, "Stopping existing daemon because mode changed", JSON.stringify({ from: this.currentMode, to: mode }));
        this.stop();
      } else {
        debugLog(this.id, "Reusing existing daemon", JSON.stringify({ mode }));
        return;
      }
    }
    this.currentMode = mode;
    const workspacePath = _PersistentAgentAdapter.resolveWorkspacePath();
    const currentCwd = workspacePath.path;
    const { cmd, args } = this.getSpawnCommand(mode);
    debugLog(this.id, "Starting daemon", JSON.stringify({ mode, cwd: currentCwd, cwdSource: workspacePath.source, cmd, args }));
    const safeEnv = { ...process.env, TERM: "dumb", CI: "false", FORCE_COLOR: "0" };
    if (process.platform === "win32" && !safeEnv.CLAUDE_CODE_GIT_BASH_PATH) {
      safeEnv.CLAUDE_CODE_GIT_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe";
    }
    this.sanitizeSpawnEnv(safeEnv);
    this.childProcess = platformSpawn(cmd, args, {
      cwd: currentCwd,
      env: safeEnv
    });
    this.childProcess.stdout.on("data", (data) => {
      const chunk = (0, import_strip_ansi.default)(decodeBuffer(data));
      debugLog(this.id, "daemon stdout chunk", formatChunk(chunk));
      this.handleOutput(chunk);
    });
    this.childProcess.stderr.on("data", (data) => {
      const chunk = (0, import_strip_ansi.default)(decodeBuffer(data));
      debugLog(this.id, "daemon stderr chunk", formatChunk(chunk));
      this.handleOutput(chunk, true);
    });
    this.childProcess.on("error", (err) => {
      debugLog(this.id, "Daemon process error", err.stack || String(err));
      if (this.turnReject) {
        this.turnReject(err);
        this.resetTurnState();
      }
    });
    this.childProcess.on("close", (code) => {
      debugLog(this.id, "Daemon process closed", JSON.stringify({ code, mode: this.currentMode }));
      this.childProcess = null;
      if (this.turnReject) {
        this.turnReject(new Error(`Daemon exited unexpectedly (code ${code})`));
        this.resetTurnState();
      }
    });
  }
  handleOutput(chunk, isError = false) {
    if (this.outputBuffer.length > MAX_OUTPUT_BUFFER_BYTES) {
      const keepFrom = this.outputBuffer.length - Math.floor(MAX_OUTPUT_BUFFER_BYTES * 0.8);
      this.outputBuffer = this.outputBuffer.slice(keepFrom);
      debugLog(this.id, "Output buffer truncated to stay within safety cap");
    }
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (isError) {
        this.outputBuffer += `
> [LOG] ${line}`;
      } else {
        this.outputBuffer += !!line ? `
${line}` : "";
      }
    }
    const hasCompletionMarker = !isError && !!this.currentTurnMarker && this.outputBuffer.includes(this.currentTurnMarker);
    const hasPromptTerminator = !isError && chunk.includes(this.promptString);
    if (this.turnOnUpdate) {
      this.turnOnUpdate(this.stripTurnCompletionArtifacts(this.outputBuffer));
    }
    if (hasCompletionMarker) {
      debugLog(this.id, "Turn completion marker detected", JSON.stringify({ marker: this.currentTurnMarker }));
      if (this.turnResolve) {
        this.turnResolve(this.stripTurnCompletionArtifacts(this.outputBuffer));
        this.resetTurnState();
      }
      return;
    }
    if (hasPromptTerminator) {
      debugLog(this.id, "Prompt terminator detected", JSON.stringify({ promptString: this.promptString }));
      if (this.turnResolve) {
        this.turnResolve(this.stripTurnCompletionArtifacts(this.outputBuffer));
        this.resetTurnState();
      }
    }
  }
  resetTurnState() {
    this.turnResolve = null;
    this.turnReject = null;
    this.turnOnUpdate = null;
    this.outputBuffer = "";
    this.currentTurnMarker = null;
  }
  async invoke(prompt, mode = "plan", sessionId, onUpdate, extraEnv) {
    if (!this.shouldUsePersistentSession(mode)) {
      return this.invokeNonInteractive(prompt, mode, sessionId, onUpdate, extraEnv);
    }
    if (extraEnv && Object.keys(extraEnv).length > 0) {
      throw new Error(`extraEnv is not supported in persistent session mode. Use non-interactive mode for delegated tasks.`);
    }
    if (!this.childProcess || this.currentMode !== mode) {
      await this.initialize(mode);
    }
    return new Promise((resolve, reject) => {
      if (this.turnResolve) {
        debugLog(this.id, "Rejected invoke because agent is already busy", JSON.stringify({ mode }));
        return reject(new Error(`[${this.id}] Agent is already processing a request.`));
      }
      this.turnResolve = resolve;
      this.turnReject = reject;
      this.turnOnUpdate = onUpdate || null;
      this.outputBuffer = "";
      this.currentTurnMarker = this.buildTurnCompletionMarker();
      const safePrompt = [
        prompt.replace(/\r?\n/g, " "),
        `When you finish this turn, output exactly ${this.currentTurnMarker} on its own line.`
      ].join(" ") + "\n";
      debugLog(this.id, "Writing prompt to daemon stdin", JSON.stringify({
        mode,
        promptLength: prompt.length,
        safePromptPreview: safePrompt.slice(0, 400),
        completionMarker: this.currentTurnMarker
      }));
      this.childProcess.stdin.write(safePrompt);
    });
  }
  stop() {
    if (this.childProcess) {
      debugLog(this.id, "Killing child process", JSON.stringify({ pid: this.childProcess.pid }));
      this.childProcess.kill();
      this.childProcess = null;
    }
  }
};

// ../src/adapters/ClaudeCodeAdapter.ts
var CLAUDE_PROCESS_LINE_RE = /^[⏺●•└│├↳✓✗]/;
var ClaudeCodeAdapter = class extends PersistentAgentAdapter {
  constructor(id = "claude-code", name = "\u{1F996} Claude Code", modelFlag = "", modes) {
    super(id, name, modelFlag, ">", modes);
  }
  shouldUsePersistentSession(mode) {
    return false;
  }
  shouldUseStructuredOutput(mode) {
    return mode === "plan" || mode === "agent";
  }
  getNonInteractiveCommand(mode, prompt, sessionId) {
    const command = super.getNonInteractiveCommand(mode, prompt, sessionId);
    if (this.shouldUseStructuredOutput(mode)) {
      command.args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");
    }
    if (sessionId) {
      command.args.push("--resume", sessionId);
    }
    return command;
  }
  extractStructuredUsageLog(event) {
    if (event?.type !== "result" || !event?.usage) {
      return void 0;
    }
    const usage = event.usage;
    const lines = [
      typeof usage.input_tokens === "number" ? `Input tokens: ${usage.input_tokens}` : "",
      typeof usage.output_tokens === "number" ? `Output tokens: ${usage.output_tokens}` : "",
      typeof event.total_cost_usd === "number" ? `Cost: $${event.total_cost_usd.toFixed(6)}` : "",
      typeof event.duration_ms === "number" ? `Duration: ${event.duration_ms}ms` : "",
      event.modelUsage ? `Model usage: ${JSON.stringify(event.modelUsage)}` : ""
    ].filter(Boolean);
    return lines.length > 0 ? lines.join("\n") : void 0;
  }
  extractThinking(rawText) {
    return this.extractThinkingWithSharedParser(rawText, {
      processLineRe: CLAUDE_PROCESS_LINE_RE,
      captureProcessLinesAfterOutputStarts: true
    });
  }
  getSpawnCommand(mode) {
    const args = [];
    const cwd = PersistentAgentAdapter.getWorkspacePath();
    const fs8 = require("fs");
    const path8 = require("path");
    args.push("--add-dir", cwd);
    const localMcpPath = path8.join(cwd, ".vscode", "mcp.json");
    if (fs8.existsSync(localMcpPath)) {
      try {
        let mcpContent = fs8.readFileSync(localMcpPath, "utf8");
        mcpContent = mcpContent.replace(/\$\{workspaceFolder\}/g, cwd.replace(/\\/g, "/"));
        mcpContent = mcpContent.replace(/\$\{env:(\w+)\}/g, (_2, varName) => {
          return (process.env[varName] || "").replace(/\\/g, "/");
        });
        const localMcp = JSON.parse(mcpContent);
        const claudeMcp = { mcpServers: localMcp.servers || localMcp.mcpServers || {} };
        const proxyMcpPath = path8.join(cwd, ".optimus", ".claude-mcp.json");
        fs8.mkdirSync(path8.dirname(proxyMcpPath), { recursive: true });
        fs8.writeFileSync(proxyMcpPath, JSON.stringify(claudeMcp, null, 2));
        args.push("--mcp-config", proxyMcpPath);
      } catch (e) {
      }
      args.push("--strict-mcp-config");
    } else {
      args.push("--strict-mcp-config");
    }
    if (this.modelFlag) {
      args.push("--model", this.modelFlag);
    }
    if (mode === "plan") {
      args.push("--permission-mode", "plan");
    } else if (mode === "agent") {
      args.push("--dangerously-skip-permissions");
    }
    return { cmd: "claude", args };
  }
};

// ../src/adapters/GitHubCopilotAdapter.ts
var COPILOT_PROCESS_LINE_RE = /^[●⏺•└│├▶→↳✓✗]/;
var GitHubCopilotAdapter = class extends PersistentAgentAdapter {
  constructor(id = "github-copilot", name = "\u{1F6F8} GitHub Copilot", modelFlag = "", modes) {
    super(id, name, modelFlag, "?>", modes);
  }
  shouldUsePersistentSession(mode) {
    return false;
  }
  shouldUseStructuredOutput(mode) {
    return mode === "plan" || mode === "agent";
  }
  getNonInteractiveCommand(mode, prompt, sessionId) {
    const command = super.getNonInteractiveCommand(mode, prompt, sessionId);
    if (this.shouldUseStructuredOutput(mode)) {
      command.args.push("--output-format", "json", "--stream", "on");
    }
    if (sessionId) {
      command.args.push("--resume", sessionId);
    }
    return command;
  }
  extractStructuredUsageLog(event) {
    if (event?.type !== "result" || !event?.usage) {
      return void 0;
    }
    const usage = event.usage;
    const lines = [
      typeof usage.premiumRequests === "number" ? `Premium requests: ${usage.premiumRequests}` : "",
      typeof usage.totalApiDurationMs === "number" ? `API duration: ${usage.totalApiDurationMs}ms` : "",
      typeof usage.sessionDurationMs === "number" ? `Session duration: ${usage.sessionDurationMs}ms` : "",
      usage.codeChanges ? `Code changes: ${JSON.stringify(usage.codeChanges)}` : ""
    ].filter(Boolean);
    return lines.length > 0 ? lines.join("\n") : void 0;
  }
  extractThinking(rawText) {
    return this.extractThinkingWithSharedParser(rawText, {
      processLineRe: COPILOT_PROCESS_LINE_RE,
      captureBracketLines: true,
      captureProcessLinesAfterOutputStarts: true,
      collectUsageLog: true
    });
  }
  getSpawnCommand(mode) {
    const args = [];
    const cwd = PersistentAgentAdapter.getWorkspacePath();
    args.push("--add-dir", cwd);
    if (this.modelFlag) {
      args.push("--model", this.modelFlag);
    }
    if (mode === "plan") {
    } else if (mode === "agent") {
      args.push("--allow-all");
      args.push("--no-ask-user");
    }
    return { cmd: "copilot", args };
  }
  /**
   * Strip GITHUB_TOKEN and GH_TOKEN from the spawn environment.
   * Copilot CLI treats these as auth inputs, but in Optimus they contain
   * a generic GitHub PAT (from .env) for VCS operations — not a Copilot token.
   * This shadowing breaks Copilot's own keyring-based authentication.
   * Only forward if COPILOT_GITHUB_TOKEN is explicitly set.
   */
  sanitizeSpawnEnv(env) {
    if (!env.COPILOT_GITHUB_TOKEN) {
      delete env.GITHUB_TOKEN;
      delete env.GH_TOKEN;
    }
  }
};

// ../src/utils/sanitizeExternalContent.ts
var PATTERNS = [
  {
    name: "html-comment-override",
    regex: /<!--[\s\S]*?(ignore previous|override|system:|you are now)[\s\S]*?-->/gi
  },
  {
    name: "prompt-override",
    regex: /^\s*(IGNORE ALL PREVIOUS|IGNORE ALL INSTRUCTIONS|YOU ARE NOW|SYSTEM:|IMPORTANT:\s*override|IMPORTANT:\s*ignore)/gim
  },
  {
    name: "dangerous-shell",
    regex: /curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|rm\s+-rf\s+\/|>\s*\/dev\/null.*&&/gi
  }
];
function sanitizeExternalContent(content, source) {
  const detections = [];
  let sanitized = content;
  for (const pattern of PATTERNS) {
    const matches = sanitized.match(pattern.regex);
    if (matches) {
      for (const match of matches) {
        detections.push(`${pattern.name}: ${match.substring(0, 80)}`);
        console.error(`[Security] Prompt injection pattern detected in ${source}: ${pattern.name}`);
      }
      sanitized = sanitized.replace(pattern.regex, "[REDACTED: potential prompt injection detected]");
    }
  }
  return { sanitized, detections };
}

// ../src/mcp/worker-spawner.ts
function parseFrontmatter(content) {
  const normalized = content.replace(/\r\n/g, "\n");
  const yamlRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = normalized.match(yamlRegex);
  let frontmatter = {};
  let body = normalized;
  if (match) {
    const yamlBlock = match[1];
    body = match[2];
    yamlBlock.split("\n").forEach((line) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, "");
        if (key) frontmatter[key] = value;
      }
    });
  }
  return { frontmatter, body };
}
function updateFrontmatter(content, updates) {
  const parsed = parseFrontmatter(content);
  const newFm = { ...parsed.frontmatter, ...updates };
  let yamlStr = "---\n";
  for (const [k2, v2] of Object.entries(newFm)) {
    yamlStr += `${k2}: ${v2}
`;
  }
  yamlStr += "---";
  const bodyStr = parsed.body.startsWith("\n") ? parsed.body : "\n" + parsed.body;
  return yamlStr + bodyStr;
}
function sanitizeRoleName(role) {
  return role.replace(/[^a-zA-Z0-9_-]/g, "").substring(0, 100);
}
var t3LogMutex = Promise.resolve();
function getT3UsageLogPath(workspacePath) {
  return import_path.default.join(workspacePath, ".optimus", "state", "t3-usage-log.json");
}
function loadT3UsageLog(workspacePath) {
  const logPath = getT3UsageLogPath(workspacePath);
  try {
    if (import_fs.default.existsSync(logPath)) {
      return JSON.parse(import_fs.default.readFileSync(logPath, "utf8"));
    }
  } catch {
  }
  return {};
}
function saveT3UsageLog(workspacePath, log) {
  const logPath = getT3UsageLogPath(workspacePath);
  const dir = import_path.default.dirname(logPath);
  if (!import_fs.default.existsSync(dir)) import_fs.default.mkdirSync(dir, { recursive: true });
  import_fs.default.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8");
}
function trackT3Usage(workspacePath, role, success, engine, model) {
  t3LogMutex = t3LogMutex.then(() => {
    const log = loadT3UsageLog(workspacePath);
    if (!log[role]) {
      log[role] = { role, invocations: 0, successes: 0, failures: 0, consecutive_failures: 0, lastUsed: "", engine, model };
    }
    if (log[role].consecutive_failures === void 0) {
      log[role].consecutive_failures = 0;
    }
    log[role].invocations++;
    if (success) {
      log[role].successes++;
      log[role].consecutive_failures = 0;
    } else {
      log[role].failures++;
      log[role].consecutive_failures++;
    }
    log[role].lastUsed = (/* @__PURE__ */ new Date()).toISOString();
    log[role].engine = engine;
    if (model) log[role].model = model;
    saveT3UsageLog(workspacePath, log);
  }).catch(() => {
  });
}
function checkRequiredSkills(workspacePath, skills) {
  const found = /* @__PURE__ */ new Map();
  const missing = [];
  for (const skill of skills) {
    const skillPath = import_path.default.join(workspacePath, ".optimus", "skills", skill, "SKILL.md");
    if (import_fs.default.existsSync(skillPath)) {
      found.set(skill, import_fs.default.readFileSync(skillPath, "utf8"));
    } else {
      missing.push(skill);
    }
  }
  return { found, missing };
}
function loadValidEnginesAndModels(workspacePath) {
  const configPath = import_path.default.join(workspacePath, ".optimus", "config", "available-agents.json");
  try {
    if (import_fs.default.existsSync(configPath)) {
      const config = JSON.parse(import_fs.default.readFileSync(configPath, "utf8"));
      const engines = Object.keys(config.engines || {});
      const models = {};
      for (const eng of engines) {
        models[eng] = config.engines[eng]?.available_models || [];
      }
      return { engines, models };
    }
  } catch {
  }
  return { engines: [], models: {} };
}
function isValidEngine(engine, validEngines) {
  return validEngines.length === 0 || validEngines.includes(engine);
}
function isValidModel(model, engine, validModels) {
  const allowed = validModels[engine];
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(model);
}
async function ensureT2Role(workspacePath, role, engine, model, masterInfo, delegationDepth) {
  const safeRole = sanitizeRoleName(role);
  const t2Dir = import_path.default.join(workspacePath, ".optimus", "roles");
  const t2Path = import_path.default.join(t2Dir, `${safeRole}.md`);
  if (!import_fs.default.existsSync(t2Dir)) import_fs.default.mkdirSync(t2Dir, { recursive: true });
  const formattedRole = safeRole.split(/[-_]+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  const rawDesc = masterInfo?.description || `${formattedRole} expert`;
  const desc = rawDesc.replace(/\\n/g, "\n");
  const eng = masterInfo?.engine || engine;
  const mod = masterInfo?.model || model || "";
  if (import_fs.default.existsSync(t2Path)) {
    if (masterInfo?.description || masterInfo?.engine || masterInfo?.model) {
      const existing = import_fs.default.readFileSync(t2Path, "utf8");
      const updates = {};
      if (masterInfo.description) updates.description = `"${masterInfo.description.substring(0, 200).replace(/"/g, "'")}"`;
      const { engines: validEngines, models: validModels } = loadValidEnginesAndModels(workspacePath);
      if (masterInfo.engine) {
        if (isValidEngine(masterInfo.engine, validEngines)) {
          updates.engine = masterInfo.engine;
        } else {
          console.error(`[T2 Guard] Rejected invalid engine '${masterInfo.engine}' for role '${safeRole}'. Valid: ${validEngines.join(", ")}`);
        }
      }
      if (masterInfo.model) {
        const resolvedEng = updates.engine || parseFrontmatter(existing).frontmatter.engine || engine;
        if (isValidModel(masterInfo.model, resolvedEng, validModels)) {
          updates.model = masterInfo.model;
        } else {
          console.error(`[T2 Guard] Rejected invalid model '${masterInfo.model}' for engine '${resolvedEng}' on role '${safeRole}'. Valid: ${(validModels[resolvedEng] || []).join(", ")}`);
        }
      }
      updates.updated_at = (/* @__PURE__ */ new Date()).toISOString();
      const updated = updateFrontmatter(existing, updates);
      import_fs.default.writeFileSync(t2Path, updated, "utf8");
      console.error(`[T2 Evolution] Updated role '${safeRole}' template with new Master info`);
    }
    return null;
  }
  const pluginRolePaths = [
    import_path.default.join(__dirname, "..", "..", "roles", `${safeRole}.md`),
    // from dist/
    import_path.default.join(__dirname, "..", "..", "..", "optimus-plugin", "roles", `${safeRole}.md`)
    // from src/mcp/
  ];
  for (const pluginPath of pluginRolePaths) {
    try {
      if (import_fs.default.existsSync(pluginPath)) {
        const pluginContent = import_fs.default.readFileSync(pluginPath, "utf8");
        let finalContent = pluginContent;
        const updates = {};
        const { engines: validEnginesPlugin, models: validModelsPlugin } = loadValidEnginesAndModels(workspacePath);
        if (eng) {
          if (isValidEngine(eng, validEnginesPlugin)) {
            updates.engine = eng;
          } else {
            console.error(`[T2 Guard] Rejected invalid engine '${eng}' for role '${safeRole}'. Valid: ${validEnginesPlugin.join(", ")}`);
          }
        }
        if (mod) {
          const resolvedEngPlugin = updates.engine || eng;
          if (updates.engine && isValidModel(mod, resolvedEngPlugin, validModelsPlugin)) {
            updates.model = mod;
          } else if (!updates.engine) {
            console.error(`[T2 Guard] Discarding model '${mod}' \u2014 engine was invalid for role '${safeRole}'`);
          } else {
            console.error(`[T2 Guard] Rejected invalid model '${mod}' for engine '${resolvedEngPlugin}' on role '${safeRole}'. Valid: ${(validModelsPlugin[resolvedEngPlugin] || []).join(", ")}`);
          }
        }
        updates.precipitated = (/* @__PURE__ */ new Date()).toISOString();
        if (Object.keys(updates).length > 0) {
          finalContent = updateFrontmatter(pluginContent, updates);
        }
        import_fs.default.writeFileSync(t2Path, finalContent, "utf8");
        console.error(`[Precipitation] T3 role '${safeRole}' promoted to T2 from plugin template at ${t2Path}`);
        return t2Path;
      }
    } catch {
    }
  }
  const META_ROLES = ["agent-creator", "skill-creator"];
  const safeRoleCheck = sanitizeRoleName(role);
  const currentDepthLocal = delegationDepth ?? 0;
  const { engines: validEnginesFallback, models: validModelsFallback } = loadValidEnginesAndModels(workspacePath);
  let validatedEng = eng;
  let validatedMod = mod;
  if (eng && !isValidEngine(eng, validEnginesFallback)) {
    console.error(`[T2 Guard] Rejected invalid engine '${eng}' for role '${safeRole}'. Valid: ${validEnginesFallback.join(", ")}`);
    validatedEng = validEnginesFallback[0] || "";
    validatedMod = "";
  } else if (mod && !isValidModel(mod, eng, validModelsFallback)) {
    console.error(`[T2 Guard] Rejected invalid model '${mod}' for engine '${eng}' on role '${safeRole}'. Valid: ${(validModelsFallback[eng] || []).join(", ")}`);
    validatedMod = "";
  }
  if (META_ROLES.includes(safeRoleCheck) || currentDepthLocal >= MAX_DELEGATION_DEPTH - 1) {
    console.error(`[Precipitation] Falling back to thin template for '${safeRole}' (meta-role: ${META_ROLES.includes(safeRoleCheck)}, depth: ${currentDepthLocal}/${MAX_DELEGATION_DEPTH})`);
    const template = `---
role: ${safeRole}
tier: T2
description: "${desc.substring(0, 200).replace(/"/g, "'")}"
engine: ${validatedEng}
model: ${validatedMod}
precipitated: ${(/* @__PURE__ */ new Date()).toISOString()}
---

# ${formattedRole}

${desc}
`;
    import_fs.default.writeFileSync(t2Path, template, "utf8");
    console.error(`[Precipitation] T3 role '${safeRole}' promoted to T2 (thin) at ${t2Path}`);
    return t2Path;
  }
  try {
    await generateRichT2Role(workspacePath, role, validatedEng, validatedMod || void 0, desc, t2Path, currentDepthLocal);
    console.error(`[Precipitation] T3 role '${safeRole}' promoted to T2 (rich, via agent-creator) at ${t2Path}`);
    return t2Path;
  } catch (err) {
    console.error(`[Precipitation] agent-creator failed for '${safeRole}': ${err.message}. Falling back to thin template.`);
    const template = `---
role: ${safeRole}
tier: T2
description: "${desc.substring(0, 200).replace(/"/g, "'")}"
engine: ${validatedEng}
model: ${validatedMod}
precipitated: ${(/* @__PURE__ */ new Date()).toISOString()}
---

# ${formattedRole}

${desc}
`;
    import_fs.default.writeFileSync(t2Path, template, "utf8");
    return t2Path;
  }
}
function enhanceT2RoleAsync(workspacePath, role, taskDescription, childDepth) {
  const META_ROLE_EXCLUSIONS = ["agent-creator", "skill-creator"];
  const safeRole = sanitizeRoleName(role);
  if (META_ROLE_EXCLUSIONS.includes(safeRole)) {
    console.error(`[T2 Enhancement] Skipping meta-role '${safeRole}' (excluded)`);
    return;
  }
  if (childDepth >= MAX_DELEGATION_DEPTH - 1) {
    console.error(`[T2 Enhancement] Skipping \u2014 delegation depth ${childDepth} too deep (max ${MAX_DELEGATION_DEPTH})`);
    return;
  }
  const t2Path = import_path.default.join(workspacePath, ".optimus", "roles", `${safeRole}.md`);
  if (!import_fs.default.existsSync(t2Path)) {
    console.error(`[T2 Enhancement] Skipping \u2014 no T2 file at ${t2Path}`);
    return;
  }
  const t2Content = import_fs.default.readFileSync(t2Path, "utf8");
  if (t2Content.includes("enhanced: true")) {
    console.error(`[T2 Enhancement] Skipping '${safeRole}' \u2014 already enhanced`);
    return;
  }
  console.error(`[T2 Enhancement] Queuing async enhancement for '${safeRole}'`);
  const { TaskManifestManager: TaskManifestManager2 } = (init_TaskManifestManager(), __toCommonJS(TaskManifestManager_exports));
  const taskId = `enhance_${safeRole}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  TaskManifestManager2.createTask(workspacePath, {
    taskId,
    type: "delegate_task",
    role: "agent-creator",
    task_description: `Enhance the thin T2 role template for '${safeRole}' at .optimus/roles/${safeRole}.md.

Current template is auto-precipitated from T3 execution and only contains a basic description. Your job:

1. Read the existing T2 file at .optimus/roles/${safeRole}.md
2. Read the agent-creator skill at .optimus/skills/agent-creator/SKILL.md for the template structure
3. Rewrite the role file to be a professional-grade role definition with:
   - Clear behavioral instructions (what the role does, how it thinks)
   - Tool usage patterns (which MCP tools it typically uses)
   - Workflow steps (numbered phases or procedures)
   - Constraints and prohibitions (what it must NOT do)
   - Output format expectations
4. Preserve the existing frontmatter fields (role, tier, engine, model, precipitated)
5. ADD these frontmatter fields:
   - enhanced: true
   - auto_enhanced: true
   - enhanced_at: <current ISO timestamp>
6. Keep the role name and description consistent with the original

The original task this role was used for: "${taskDescription.substring(0, 500).replace(/"/g, "'")}"

IMPORTANT: Write the enhanced role file directly to .optimus/roles/${safeRole}.md (overwrite the thin template).
Do NOT create a new file \u2014 update the existing one in place.`,
    output_path: `.optimus/reports/t2_enhancement_${safeRole}.md`,
    workspacePath,
    role_description: "Expert in designing AI agent role definitions with behavioral specificity, tool patterns, and workflow structure",
    required_skills: ["agent-creator"],
    delegation_depth: childDepth + 1
  });
  const { spawn: spawnProcess } = require("child_process");
  const child = spawnProcess(process.execPath, [
    __filename,
    "--run-task",
    taskId,
    workspacePath
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      OPTIMUS_DELEGATION_DEPTH: String(childDepth + 1)
    }
  });
  child.unref();
  console.error(`[T2 Enhancement] Spawned background enhancement for '${safeRole}' (taskId: ${taskId})`);
}
async function generateRichT2Role(workspacePath, role, engine, model, description, t2Path, delegationDepth) {
  const safeRole = sanitizeRoleName(role);
  const skillPath = import_path.default.join(workspacePath, ".optimus", "skills", "agent-creator", "SKILL.md");
  let agentCreatorSkillContent = "";
  if (import_fs.default.existsSync(skillPath)) {
    agentCreatorSkillContent = import_fs.default.readFileSync(skillPath, "utf8");
  }
  const formattedRole = safeRole.split(/[-_]+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  const prompt = `You are a role-creation specialist. Your task is to create a professional-grade T2 role template.

Role name: ${safeRole}
Role display name: ${formattedRole}
Role description: ${description}
Engine: ${engine}
Model: ${model || "default"}

Using the agent-creator skill guidance below, produce a COMPLETE role definition file.

The output MUST be a valid markdown file with YAML frontmatter. Output ONLY the file content \u2014 no explanations, no code fences around it.

Required frontmatter fields:
---
role: ${safeRole}
tier: T2
description: "<rich 1-2 sentence description>"
engine: ${engine}
model: ${model || ""}
precipitated: ${(/* @__PURE__ */ new Date()).toISOString()}
auto_created: true
---

Required body sections:
# ${formattedRole}
<2-3 sentence purpose statement>
## Core Responsibilities
- <3-5 specific actionable responsibilities>
## Quality Standards
- <2-3 measurable quality criteria>
## Constraints
- <2-3 behavioral boundaries>

${agentCreatorSkillContent ? `=== SKILL REFERENCE ===
${agentCreatorSkillContent}
=== END SKILL REFERENCE ===` : ""}`;
  const adapter = getAdapterForEngine(engine, void 0, model);
  const childDepth = delegationDepth + 1;
  const extraEnv = {
    OPTIMUS_DELEGATION_DEPTH: String(childDepth)
  };
  const response = await adapter.invoke(prompt, "agent", void 0, void 0, extraEnv);
  const fmStart = response.indexOf("---");
  if (fmStart === -1) {
    throw new Error("agent-creator response did not contain valid frontmatter (no --- found)");
  }
  const content = response.slice(fmStart).trim();
  const secondDash = content.indexOf("---", 3);
  if (secondDash === -1) {
    throw new Error("agent-creator response had opening --- but no closing frontmatter delimiter");
  }
  const dir = import_path.default.dirname(t2Path);
  if (!import_fs.default.existsSync(dir)) import_fs.default.mkdirSync(dir, { recursive: true });
  import_fs.default.writeFileSync(t2Path, content, "utf8");
}
var AgentLockManager = class {
  locks = /* @__PURE__ */ new Map();
  resolvers = /* @__PURE__ */ new Map();
  workspacePath;
  constructor(workspacePath) {
    this.workspacePath = workspacePath;
  }
  get lockDir() {
    return import_path.default.join(this.workspacePath, ".optimus", "agents");
  }
  lockFilePath(role) {
    return import_path.default.join(this.lockDir, `${role}.lock`);
  }
  async acquireLock(role) {
    while (this.locks.has(role)) {
      await this.locks.get(role);
    }
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    this.locks.set(role, promise);
    this.resolvers.set(role, resolve);
    this.writeLockFile(role);
  }
  releaseLock(role) {
    const resolve = this.resolvers.get(role);
    this.locks.delete(role);
    this.resolvers.delete(role);
    this.deleteLockFile(role);
    if (resolve) resolve();
  }
  writeLockFile(role) {
    try {
      if (!import_fs.default.existsSync(this.lockDir)) {
        import_fs.default.mkdirSync(this.lockDir, { recursive: true });
      }
      import_fs.default.writeFileSync(this.lockFilePath(role), JSON.stringify({ pid: process.pid, timestamp: Date.now() }), "utf8");
    } catch {
    }
  }
  deleteLockFile(role) {
    try {
      import_fs.default.unlinkSync(this.lockFilePath(role));
    } catch {
    }
  }
  cleanStaleLocks() {
    try {
      if (!import_fs.default.existsSync(this.lockDir)) return;
      const files = import_fs.default.readdirSync(this.lockDir);
      for (const file of files) {
        if (!file.endsWith(".lock")) continue;
        const filePath = import_path.default.join(this.lockDir, file);
        try {
          const content = JSON.parse(import_fs.default.readFileSync(filePath, "utf8"));
          if (content.pid && !isProcessRunning(content.pid)) {
            import_fs.default.unlinkSync(filePath);
            console.error(`[AgentLockManager] Cleaned stale lock for ${file} (PID ${content.pid} no longer running)`);
          }
        } catch {
          try {
            import_fs.default.unlinkSync(filePath);
          } catch {
          }
        }
      }
    } catch {
    }
  }
};
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
var lockManagerInstance = null;
function getLockManager(workspacePath) {
  if (!lockManagerInstance) {
    lockManagerInstance = new AgentLockManager(workspacePath);
    lockManagerInstance.cleanStaleLocks();
  }
  return lockManagerInstance;
}
var ConcurrencyGovernor = class {
  static maxConcurrentWorkers = 3;
  static activeWorkers = 0;
  static queue = [];
  static async acquire() {
    if (this.activeWorkers < this.maxConcurrentWorkers) {
      this.activeWorkers++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
  static release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.activeWorkers--;
    }
  }
};
function parseRoleSpec(roleArg) {
  const segments = import_path.default.basename(roleArg).split("_").filter(Boolean);
  const engineIndex = segments.findIndex((segment) => segment === "claude-code" || segment === "copilot-cli" || segment === "github-copilot");
  if (engineIndex === -1) {
    return { role: import_path.default.basename(roleArg) };
  }
  const role = segments.slice(0, engineIndex).join("_") || import_path.default.basename(roleArg);
  const engine = segments[engineIndex];
  const model = segments.slice(engineIndex + 1).join("_");
  return { role, engine, model };
}
function getAdapterForEngine(engine, sessionId, model) {
  if (engine === "copilot-cli" || engine === "github-copilot") {
    return new GitHubCopilotAdapter(void 0, "\u{1F6F8} GitHub Copilot", model || "");
  }
  return new ClaudeCodeAdapter(void 0, "\u{1F996} Claude Code", model || "");
}
function loadProjectMemory(workspacePath, maxChars = 4e3) {
  const memoryFile = import_path.default.join(workspacePath, ".optimus", "memory", "continuous-memory.md");
  if (!import_fs.default.existsSync(memoryFile)) return "";
  try {
    const raw = import_fs.default.readFileSync(memoryFile, "utf8");
    if (!raw.trim()) return "";
    const entries = raw.split(/(?=^---\nid:)/m).filter((e) => e.trim());
    entries.reverse();
    let content = "";
    for (const entry of entries) {
      const body = entry.replace(/^---[\s\S]*?---\n?/m, "").trim();
      if (!body) continue;
      if (content.length + body.length + 4 > maxChars) break;
      content = body + "\n\n" + content;
    }
    return content.trim();
  } catch (e) {
    return "";
  }
}
async function delegateTaskSingle(roleArg, taskPath, outputPath, _fallbackSessionId, workspacePath, contextFiles, masterInfo, parentDepth, parentIssueNumber, autoIssueNumber) {
  const parsedRole = parseRoleSpec(roleArg);
  const role = sanitizeRoleName(parsedRole.role);
  const currentDepth = parentDepth !== void 0 ? parentDepth : parseInt(process.env.OPTIMUS_DELEGATION_DEPTH || "0", 10);
  const childDepth = currentDepth + 1;
  console.error(`[Orchestrator] Delegation depth: ${childDepth}/${MAX_DELEGATION_DEPTH}`);
  if (childDepth >= MAX_DELEGATION_DEPTH) {
    console.error(`[Orchestrator] Max delegation depth reached \u2014 MCP config will be stripped`);
  }
  const legacyT1Dir = import_path.default.join(workspacePath, ".optimus", "personas");
  const t1Dir = import_path.default.join(workspacePath, ".optimus", "agents");
  if (import_fs.default.existsSync(legacyT1Dir) && !import_fs.default.existsSync(t1Dir)) {
    try {
      import_fs.default.renameSync(legacyT1Dir, t1Dir);
    } catch (e) {
    }
  }
  const t2Dir = import_path.default.join(workspacePath, ".optimus", "roles");
  if (!import_fs.default.existsSync(t2Dir)) {
    import_fs.default.mkdirSync(t2Dir, { recursive: true });
  }
  const t2Path = import_path.default.join(t2Dir, `${role}.md`);
  let activeEngine = masterInfo?.engine || parsedRole.engine;
  let activeModel = masterInfo?.model || parsedRole.model;
  let activeMode = masterInfo?.mode || "agent";
  let activeSessionId = void 0;
  let t1Content = "";
  let t1Path = "";
  let shouldLocalize = false;
  let resolvedTier = "T3 (Zero-Shot Outsource)";
  let personaProof = "No dedicated role template found in T2 or T1. Using T3 generic prompt.";
  if (import_fs.default.existsSync(t1Dir)) {
    const t1Candidates = import_fs.default.readdirSync(t1Dir).filter((f) => f.startsWith(`${role}_`) && f.endsWith(".md"));
    for (const candidate of t1Candidates) {
      const candidatePath = import_path.default.join(t1Dir, candidate);
      const candidateFm = parseFrontmatter(import_fs.default.readFileSync(candidatePath, "utf8"));
      if (!activeEngine || candidateFm.frontmatter.engine === activeEngine) {
        t1Path = candidatePath;
        t1Content = import_fs.default.readFileSync(candidatePath, "utf8");
        resolvedTier = `T1 (Agent Instance -> ${candidate})`;
        personaProof = `Found local project agent state: ${t1Path}`;
        break;
      }
    }
  }
  if (!t1Content && import_fs.default.existsSync(t2Path)) {
    t1Content = import_fs.default.readFileSync(t2Path, "utf8");
    shouldLocalize = true;
    resolvedTier = `T2 (Role Template -> ${role}.md)`;
    personaProof = `Found globally promoted Role template: ${t2Path}`;
  }
  if (t1Content) {
    const fm = parseFrontmatter(t1Content);
    if (fm.frontmatter.engine && !activeEngine) activeEngine = fm.frontmatter.engine;
    if (fm.frontmatter.session_id) activeSessionId = fm.frontmatter.session_id;
    if (fm.frontmatter.model && !activeModel) activeModel = fm.frontmatter.model;
    if (fm.frontmatter.mode && !masterInfo?.mode) activeMode = fm.frontmatter.mode;
  }
  if (t1Content) {
    const qfm = parseFrontmatter(t1Content);
    if (qfm.frontmatter.status === "quarantined") {
      throw new Error(
        `\u26A0\uFE0F **Role Quarantined**: Role '${role}' is quarantined due to repeated failures (quarantined at: ${qfm.frontmatter.quarantined_at || "unknown"}). Fix the role template at '.optimus/roles/${role}.md' or delete it to allow T3 re-creation.`
      );
    }
  }
  if (import_fs.default.existsSync(t2Path)) {
    const t2Fm = parseFrontmatter(import_fs.default.readFileSync(t2Path, "utf8"));
    if (t2Fm.frontmatter.status === "quarantined") {
      throw new Error(
        `\u26A0\uFE0F **Role Quarantined**: Role '${role}' is quarantined due to repeated failures (quarantined at: ${t2Fm.frontmatter.quarantined_at || "unknown"}). Fix the role template at '.optimus/roles/${role}.md' or delete it to allow T3 re-creation.`
      );
    }
  }
  if (!activeEngine) {
    const configPath = import_path.default.join(workspacePath, ".optimus", "config", "available-agents.json");
    try {
      if (import_fs.default.existsSync(configPath)) {
        const config = JSON.parse(import_fs.default.readFileSync(configPath, "utf8"));
        const engines = Object.keys(config.engines || {}).filter(
          (e) => !config.engines[e].status?.includes("demo")
        );
        if (engines.length > 0) {
          activeEngine = engines.includes("claude-code") ? "claude-code" : engines[0];
          if (!activeModel) {
            const models = config.engines[activeEngine]?.available_models;
            if (Array.isArray(models) && models.length > 0) {
              activeModel = models[0];
            }
          }
        }
      }
    } catch {
    }
  }
  if (!activeEngine) {
    throw new Error(
      `\u26A0\uFE0F **Engine Resolution Failed**: Unable to resolve a viable engine (e.g., 'github-copilot', 'claude-code') for role \`${role}\`.
No engine was specified in the caller arguments, local frontmatter, or T2 metadata. Please explicitly specify an engine or create the role with proper configurations first.`
    );
  }
  if (activeModel) {
    const modelConfigPath = import_path.default.join(workspacePath, ".optimus", "config", "available-agents.json");
    try {
      if (import_fs.default.existsSync(modelConfigPath)) {
        const config = JSON.parse(import_fs.default.readFileSync(modelConfigPath, "utf8"));
        const engineConfig = config.engines?.[activeEngine];
        if (engineConfig?.available_models && Array.isArray(engineConfig.available_models)) {
          const allowedModels = engineConfig.available_models;
          if (!allowedModels.includes(activeModel)) {
            throw new Error(
              `\u26A0\uFE0F **Model Pre-Flight Failed**: Model \`${activeModel}\` is not in the allowed list for engine \`${activeEngine}\`.

**Allowed models**: ${allowedModels.map((m2) => `\`${m2}\``).join(", ")}

Please re-delegate with a valid \`role_model\` or omit it to use the default.`
            );
          }
        }
      }
    } catch (e) {
      if (e.message?.includes("Model Pre-Flight Failed")) throw e;
    }
  }
  let skillContent = "";
  if (masterInfo?.requiredSkills && masterInfo.requiredSkills.length > 0) {
    const { found, missing } = checkRequiredSkills(workspacePath, masterInfo.requiredSkills);
    if (missing.length > 0) {
      throw new Error(
        `\u26A0\uFE0F **Skill Pre-Flight Failed**: Missing ${missing.length} required skill(s): ${missing.map((s) => `\`${s}\``).join(", ")}.

Master Agent must create these skills first via \`delegate_task_async\` to a skill-creator role, then retry this delegation.

Expected path(s):
${missing.map((s) => `- .optimus/skills/${s}/SKILL.md`).join("\n")}`
      );
    }
    for (const [name, content] of found) {
      skillContent += `

=== SKILL: ${name} ===
${content}
=== END SKILL: ${name} ===
`;
    }
    console.error(`[Orchestrator] Loaded ${found.size} skill(s) for ${role}: ${[...found.keys()].join(", ")}`);
  }
  const adapter = getAdapterForEngine(activeEngine, activeSessionId, activeModel);
  console.error(`[Orchestrator] Resolving Identity for ${role}...`);
  console.error(`[Orchestrator] Selected Stratum: ${resolvedTier}`);
  console.error(`[Orchestrator] Engine: ${activeEngine}, Session: ${activeSessionId || "New/Ephemeral"}`);
  const rawTaskText = import_fs.default.existsSync(taskPath) ? import_fs.default.readFileSync(taskPath, "utf8") : taskPath;
  const { sanitized: taskText } = sanitizeExternalContent(rawTaskText, `task:${role}`);
  let personaContext = "";
  if (t1Content) {
    personaContext = parseFrontmatter(t1Content).body.trim();
  } else {
    const formattedRole = role.split(/[-_]+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    personaContext = `You are a ${formattedRole} expert operating within the Optimus Spartan Swarm. Your purpose is to fulfill tasks autonomously within your specialized domain of expertise.
As a dynamically provisioned "T3" agent, apply industry best practices, solve complex problems, and deliver professional-grade results associated with your role.`;
    const systemInstructionsPath = import_path.default.join(workspacePath, ".optimus", "config", "system-instructions.md");
    if (import_fs.default.existsSync(systemInstructionsPath)) {
      try {
        const systemInstructions = import_fs.default.readFileSync(systemInstructionsPath, "utf8");
        personaContext += `

--- START WORKSPACE SYSTEM INSTRUCTIONS ---
${systemInstructions.trim()}
--- END WORKSPACE SYSTEM INSTRUCTIONS ---`;
      } catch (e) {
      }
    }
  }
  const memoryContent = loadProjectMemory(workspacePath);
  const memorySection = memoryContent ? `

--- START PROJECT MEMORY ---
The following are verified lessons and decisions from this project's history.
Apply them to avoid repeating past mistakes.

${memoryContent}
--- END PROJECT MEMORY ---` : "";
  let contextContent = "";
  if (contextFiles && contextFiles.length > 0) {
    contextContent = "\n\n=== CONTEXT FILES ===\n\nThe following files are provided as required context for, and must be strictly adhered to during this task:\n\n";
    for (const cf of contextFiles) {
      const absolutePath = import_path.default.resolve(workspacePath, cf);
      if (import_fs.default.existsSync(absolutePath)) {
        const rawContent = import_fs.default.readFileSync(absolutePath, "utf8");
        const { sanitized: fileContent } = sanitizeExternalContent(rawContent, `context:${cf}`);
        contextContent += `--- START OF ${cf} ---
`;
        contextContent += fileContent;
        contextContent += `
--- END OF ${cf} ---

`;
      } else {
        contextContent += `--- START OF ${cf} ---
`;
        contextContent += `(File not found at ${absolutePath})
`;
        contextContent += `--- END OF ${cf} ---

`;
      }
    }
  }
  const trackingIssueHeader = autoIssueNumber ? `
## Tracking Issue
A GitHub Issue #${autoIssueNumber} has already been created to track this task.
DO NOT create a new Issue via vcs_create_work_item. Use #${autoIssueNumber} as your Epic/tracking Issue for all sub-delegations.
Pass parent_issue_number: ${autoIssueNumber} to all delegate_task and dispatch_council calls.
` : "";
  const basePrompt = `You are a delegated AI Worker operating under the Spartan Swarm Protocol.
Your Role: ${role}
Identity: ${resolvedTier}

${personaContext ? `--- START PERSONA INSTRUCTIONS ---
${personaContext}
--- END PERSONA INSTRUCTIONS ---` : ""}
${memorySection}
Goal: Execute the following task.
System Note: ${personaProof}
${trackingIssueHeader}
Task Description:
${taskText}${contextContent}${skillContent ? `

=== EQUIPPED SKILLS ===
The following skills have been loaded for you to reference and follow:
${skillContent}
=== END SKILLS ===` : ""}

Please provide your complete execution result below.`;
  const isT3 = resolvedTier.startsWith("T3");
  const lockManager = getLockManager(workspacePath);
  await lockManager.acquireLock(role);
  try {
    await ConcurrencyGovernor.acquire();
    await ensureT2Role(workspacePath, role, activeEngine, activeModel, masterInfo, currentDepth);
    const agentsDir = import_path.default.join(workspacePath, ".optimus", "agents");
    if (!import_fs.default.existsSync(agentsDir)) import_fs.default.mkdirSync(agentsDir, { recursive: true });
    const tempId = Math.random().toString(36).slice(2, 10);
    const t1TempPath = t1Path || import_path.default.join(agentsDir, `${role}_pending_${tempId}.md`);
    if (!t1Path) {
      const t1Template = import_fs.default.existsSync(t2Path) ? import_fs.default.readFileSync(t2Path, "utf8") : `---
role: ${role}
---

# ${role}
`;
      const t1Instance = updateFrontmatter(t1Template, {
        role,
        base_tier: "T1",
        engine: activeEngine,
        ...activeModel ? { model: activeModel } : {},
        session_id: "",
        status: "running",
        created_at: (/* @__PURE__ */ new Date()).toISOString()
      });
      import_fs.default.writeFileSync(t1TempPath, t1Instance, "utf8");
      console.error(`[Orchestrator] T2\u2192T1: Created temp agent placeholder '${role}' at ${import_path.default.basename(t1TempPath)}`);
    }
    const extraEnv = {
      OPTIMUS_DELEGATION_DEPTH: String(childDepth)
    };
    if (parentIssueNumber !== void 0) {
      extraEnv.OPTIMUS_PARENT_ISSUE = String(parentIssueNumber);
    } else {
      extraEnv.OPTIMUS_PARENT_ISSUE = "";
    }
    if (autoIssueNumber !== void 0) {
      extraEnv.OPTIMUS_TRACKING_ISSUE = String(autoIssueNumber);
    }
    const response = await adapter.invoke(basePrompt, activeMode, activeSessionId, void 0, extraEnv);
    const nonLogLines = response.split("\n").filter((l) => !l.startsWith("> [LOG]")).join("\n").trim();
    const firstLines = response.slice(0, 500);
    const errorPatterns = [
      /^> \[LOG\] [Ee]rror:/m,
      /^API Error: [45]\d\d/m,
      /^error: option .* is invalid/m,
      /^Error: No authentication/m,
      /^Worker execution failed:/m
    ];
    const matchedError = errorPatterns.find((p) => p.test(firstLines));
    if (matchedError && nonLogLines.length < 100) {
      const tempFile = t1Path || import_path.default.join(workspacePath, ".optimus", "agents", `${role}_pending_${tempId}.md`);
      if (import_fs.default.existsSync(tempFile) && tempFile.includes("pending_")) {
        try {
          import_fs.default.unlinkSync(tempFile);
        } catch {
        }
      }
      throw new Error(
        `\u26A0\uFE0F **Delegation Failed (Engine Error)**: Role \`${role}\` on engine \`${activeEngine}\` returned an error.

**Error output**:
\`\`\`
${firstLines.trim()}
\`\`\`

**Suggested actions**:
- Re-delegate with a different engine (e.g., \`claude-code\` instead of \`github-copilot\`)
- Check if the model name is valid for this engine
- Verify CLI authentication (e.g., \`copilot login\`, \`claude auth\`)`
      );
    }
    const currentT1 = import_fs.default.existsSync(t1TempPath) ? t1TempPath : t1Path;
    if (currentT1 && import_fs.default.existsSync(currentT1)) {
      const currentStr = import_fs.default.readFileSync(currentT1, "utf8");
      const updates = {
        status: "idle",
        last_invoked: (/* @__PURE__ */ new Date()).toISOString()
      };
      const newSessionId = adapter.lastSessionId;
      if (newSessionId) {
        updates.session_id = newSessionId;
      }
      const updated = updateFrontmatter(currentStr, updates);
      const sessionPrefix = (newSessionId || tempId).slice(0, 8);
      const finalT1Path = import_path.default.join(agentsDir, `${role}_${sessionPrefix}.md`);
      import_fs.default.writeFileSync(finalT1Path, updated, "utf8");
      if (currentT1 !== finalT1Path && import_fs.default.existsSync(currentT1)) {
        try {
          import_fs.default.unlinkSync(currentT1);
        } catch {
        }
      }
      console.error(`[Orchestrator] T1 finalized: '${role}' \u2192 ${import_path.default.basename(finalT1Path)}, session=${newSessionId || "none"}, status=idle`);
    }
    const dir = import_path.default.dirname(outputPath);
    if (!import_fs.default.existsSync(dir)) import_fs.default.mkdirSync(dir, { recursive: true });
    import_fs.default.writeFileSync(outputPath, response, "utf8");
    if (isT3) {
      trackT3Usage(workspacePath, role, true, activeEngine, activeModel);
    }
    if (isT3) {
      try {
        enhanceT2RoleAsync(workspacePath, role, taskText, childDepth);
      } catch (enhanceError) {
        console.error(`[T2 Enhancement] Warning: failed to queue enhancement for '${role}': ${enhanceError.message}`);
      }
    }
    return `\u2705 **Task Delegation Successful**

**Agent Identity Resolved**: ${resolvedTier}
**Engine**: ${activeEngine}
**Session ID**: ${adapter.lastSessionId || "Ephemeral"}

**System Note**: ${personaProof}

Agent has finished execution. Check standard output at \`${outputPath}\`.`;
  } catch (e) {
    if (isT3) {
      trackT3Usage(workspacePath, role, false, activeEngine, activeModel);
    }
    const log = loadT3UsageLog(workspacePath);
    const entry = log[role];
    if (entry && entry.consecutive_failures >= 3 && entry.successes === 0) {
      const t2RolePath = import_path.default.join(workspacePath, ".optimus", "roles", `${sanitizeRoleName(role)}.md`);
      if (import_fs.default.existsSync(t2RolePath)) {
        const t2Content = import_fs.default.readFileSync(t2RolePath, "utf8");
        const quarantined = updateFrontmatter(t2Content, {
          status: "quarantined",
          quarantined_at: (/* @__PURE__ */ new Date()).toISOString()
        });
        import_fs.default.writeFileSync(t2RolePath, quarantined, "utf8");
        console.error(`[Meta-Immune] Role '${role}' quarantined after ${entry.consecutive_failures} consecutive failures with 0 successes`);
      }
    }
    throw new Error(`Worker execution failed: ${e.message}`);
  } finally {
    ConcurrencyGovernor.release();
    lockManager.releaseLock(role);
  }
}
async function spawnWorker(role, proposalPath, outputPath, sessionId, workspacePath, parentDepth, parentIssueNumber) {
  try {
    console.error(`[Spawner] Launching Real Worker ${role} for council review`);
    return await delegateTaskSingle(role, `Please read the architectural PROPOSAL located at: ${proposalPath}.
Provide your expert critique from the perspective of your role (${role}). Identify architectural bottlenecks, DX friction, security risks, or asynchronous race conditions. Conclude with a recommendation: Reject, Accept, or Hybrid.`, outputPath, sessionId, workspacePath, void 0, void 0, parentDepth, parentIssueNumber);
  } catch (err) {
    console.error(`[Spawner] Worker ${role} failed to start:`, err);
    return `\u274C ${role}: exited with errors (${err.message}).`;
  }
}
async function dispatchCouncilConcurrent(roles, proposalPath, reviewsPath, timestampId, workspacePath, parentDepth, parentIssueNumber) {
  const promises = roles.map((role) => {
    const outputPath = import_path.default.join(reviewsPath, `${role}_review.md`);
    return spawnWorker(role, proposalPath, outputPath, `${timestampId}_${Math.random().toString(36).slice(2, 8)}`, workspacePath, parentDepth, parentIssueNumber);
  });
  const results = await Promise.allSettled(promises);
  const succeeded = [];
  const failed = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "fulfilled") {
      succeeded.push(results[i].value);
    } else {
      const reason = results[i].reason;
      failed.push(`${roles[i]}: ${reason?.message || "Unknown error"}`);
      console.error(`[Council] Worker '${roles[i]}' failed: ${reason?.message}`);
    }
  }
  if (failed.length > 0) {
    const failSummary = `# Council Partial Failure Report

${failed.map((f) => `- ${f}`).join("\n")}
`;
    import_fs.default.writeFileSync(import_path.default.join(reviewsPath, "FAILURES.md"), failSummary, "utf8");
  }
  return succeeded;
}

// ../src/mcp/agent-gc.ts
var fs4 = __toESM(require("fs"));
var path4 = __toESM(require("path"));
function cleanStaleAgents(workspacePath, maxAgeDays = 7) {
  const agentsDir = path4.join(workspacePath, ".optimus", "agents");
  if (!fs4.existsSync(agentsDir)) return;
  const files = fs4.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1e3;
  for (const file of files) {
    if (file.endsWith(".lock")) continue;
    const filePath = path4.join(agentsDir, file);
    const content = fs4.readFileSync(filePath, "utf8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const lines = fmMatch[1].split("\n");
    const getValue = (key) => {
      const line = lines.find((l) => l.startsWith(`${key}:`));
      return line ? line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "") : void 0;
    };
    if (getValue("persistent") === "true") continue;
    const lastInvoked = getValue("last_invoked") || getValue("created_at");
    if (!lastInvoked) {
      fs4.unlinkSync(filePath);
      console.error(`[Agent GC] Removed stale T1 instance '${file}' (no timestamp found)`);
      continue;
    }
    const age = now - new Date(lastInvoked).getTime();
    if (age > maxAgeMs) {
      fs4.unlinkSync(filePath);
      console.error(`[Agent GC] Removed stale T1 instance '${file}' (last invoked: ${lastInvoked})`);
    }
  }
}

// ../src/mcp/mcp-server.ts
init_TaskManifestManager();

// ../src/utils/githubApi.ts
var import_child_process = require("child_process");
function getToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}
function parseGitRemote(workspacePath) {
  try {
    const url = (0, import_child_process.execSync)("git remote get-url origin", { cwd: workspacePath, encoding: "utf8" }).trim();
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
    return null;
  } catch {
    return null;
  }
}
async function createGitHubIssue(owner, repo, title, body, labels) {
  const token = getToken();
  if (!token) return null;
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Optimus-Agent"
      },
      body: JSON.stringify({ title, body, labels })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return { number: data.number, html_url: data.html_url };
  } catch {
    return null;
  }
}
async function commentOnGitHubIssue(owner, repo, issueNumber, body) {
  const token = getToken();
  if (!token) return false;
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Optimus-Agent"
      },
      body: JSON.stringify({ body })
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ../src/mcp/council-runner.ts
var import_fs2 = __toESM(require("fs"));
var import_path2 = __toESM(require("path"));
init_TaskManifestManager();

// ../src/utils/agentSignature.ts
function agentSignature(role, taskId) {
  const taskRef = taskId ? ` (Task: \`${taskId}\`)` : "";
  return `

---
_\u{1F916} Created by \`${role}\`${taskRef} via Optimus Spartan Swarm_`;
}

// ../src/mcp/council-runner.ts
function verifyOutputPath(outputPath) {
  if (!outputPath) return "partial";
  try {
    const stat = import_fs2.default.statSync(outputPath);
    if (stat.isFile()) {
      if (stat.size === 0) return "partial";
      const fd = import_fs2.default.openSync(outputPath, "r");
      const buffer = Buffer.alloc(1024);
      const bytesRead = import_fs2.default.readSync(fd, buffer, 0, 1024, 0);
      import_fs2.default.closeSync(fd);
      const content = buffer.slice(0, bytesRead).toString("utf8");
      const lines = content.split("\n").slice(0, 5);
      for (const line of lines) {
        if (line.includes("API Error: 5") || line.includes("> [LOG] Error:") || line.includes("> [LOG] error:") || line.includes("Worker execution failed:") || line.startsWith("\u274C")) {
          return "failed";
        }
      }
      return "verified";
    }
    if (stat.isDirectory()) {
      const files = import_fs2.default.readdirSync(outputPath);
      return files.length > 0 ? "verified" : "partial";
    }
    return "partial";
  } catch {
    return "partial";
  }
}
async function runAsyncWorker(taskId, workspacePath) {
  console.error(`[Runner] Starting async execution for task: ${taskId}`);
  const manifest = TaskManifestManager.loadManifest(workspacePath);
  const task = manifest[taskId];
  if (!task) {
    console.error(`[Runner] Task not found: ${taskId}`);
    process.exit(1);
  }
  if (task.status !== "pending") {
    console.error(`[Runner] Task already running or completed: ${taskId}`);
    process.exit(0);
  }
  const parentDepth = task.delegation_depth !== void 0 ? task.delegation_depth : void 0;
  if (parentDepth !== void 0) {
    console.error(`[Runner] Restored delegation depth: ${parentDepth} from task record`);
  }
  const parentIssueNumber = task.github_issue_number ?? task.parent_issue_number;
  if (parentIssueNumber !== void 0) {
    console.error(`[Runner] Setting OPTIMUS_PARENT_ISSUE=${parentIssueNumber} for child agents (source: ${task.github_issue_number !== void 0 ? "own issue" : "inherited parent"})`);
  }
  TaskManifestManager.updateTask(workspacePath, taskId, { status: "running", pid: process.pid });
  TaskManifestManager.heartbeat(workspacePath, taskId);
  const heartbeatInterval = setInterval(() => {
    TaskManifestManager.heartbeat(workspacePath, taskId);
  }, 15e3);
  try {
    if (task.type === "delegate_task") {
      await delegateTaskSingle(
        task.role,
        task.task_description,
        task.output_path,
        `async_${taskId}`,
        task.workspacePath,
        task.context_files,
        {
          description: task.role_description,
          engine: task.role_engine,
          model: task.role_model,
          requiredSkills: task.required_skills
        },
        parentDepth,
        parentIssueNumber,
        task.github_issue_number
        // auto-created tracking issue
      );
    } else if (task.type === "dispatch_council") {
      await dispatchCouncilConcurrent(
        task.roles,
        task.proposal_path,
        task.output_path,
        // Actually reviews path
        `async_council_${taskId}`,
        task.workspacePath,
        parentDepth,
        parentIssueNumber
      );
      const reviewsPath = task.output_path;
      const synthesisPath = import_path2.default.join(reviewsPath, "COUNCIL_SYNTHESIS.md");
      let synthesisContent = `# Council Synthesis Report

`;
      synthesisContent += `**Proposal:** \`${task.proposal_path}\`
`;
      synthesisContent += `**Council:** ${task.roles.map((r) => `\`${r}\``).join(", ")}

`;
      let synthesisVerifiedCount = 0;
      let synthesisFailedRoles = [];
      for (let i = 0; i < task.roles.length; i++) {
        const role = task.roles[i];
        const reviewFile = import_path2.default.join(reviewsPath, `${role}_review.md`);
        const status = verifyOutputPath(reviewFile);
        if (status === "verified") {
          synthesisVerifiedCount++;
          synthesisContent += `## ${i + 1}. Review from ${role}

`;
          const rawReview = import_fs2.default.readFileSync(reviewFile, "utf8");
          const { sanitized: reviewContent } = sanitizeExternalContent(rawReview, `review:${role}`);
          synthesisContent += reviewContent;
          synthesisContent += `

---

`;
        } else {
          synthesisFailedRoles.push(role);
          synthesisContent += `## ${i + 1}. Review from ${role}

`;
          synthesisContent += `*Worker failed to produce a valid review artifact (Status: ${status}).*

---

`;
        }
      }
      if (synthesisFailedRoles.length > 0) {
        const header = `> **Partial Results Warning:** ${synthesisFailedRoles.length} of ${task.roles.length} workers failed: ${synthesisFailedRoles.map((r) => `\`${r}\``).join(", ")}. Synthesis is based on ${synthesisVerifiedCount} successful review(s).

`;
        synthesisContent = synthesisContent.replace(
          `**Council:** ${task.roles.map((r) => `\`${r}\``).join(", ")}

`,
          `**Council:** ${task.roles.map((r) => `\`${r}\``).join(", ")}

${header}`
        );
      }
      import_fs2.default.writeFileSync(synthesisPath, synthesisContent, "utf8");
      console.error(`[Runner] Generated COUNCIL_SYNTHESIS.md at ${synthesisPath}`);
      try {
        const pmSynthesisPrompt = `You are the PM arbiter for this council review.

Read the following council synthesis report and produce a UNIFIED VERDICT.

Your output MUST follow this exact format:
## Unified Council Verdict
**Decision**: APPROVED / REJECTED / APPROVED_WITH_CONDITIONS
**Consensus Level**: UNANIMOUS / MAJORITY / SPLIT

### Key Agreements
- (list points all reviewers agree on)

### Conditions (if any)
- (list required changes before implementation)

### Conflicts (if any)
- (list unresolved disagreements)

### Implementation Priority
1. (ordered action items)

Here is the synthesis report:

${synthesisContent}`;
        const verdictPath = import_path2.default.join(reviewsPath, "VERDICT.md");
        await delegateTaskSingle(
          "pm",
          pmSynthesisPrompt,
          verdictPath,
          `reduce_${taskId}`,
          task.workspacePath,
          void 0,
          void 0,
          parentDepth
        );
        console.error(`[Runner] PM verdict generated at ${verdictPath}`);
      } catch (reduceErr) {
        console.error(`[Runner] PM reduce phase failed (non-fatal): ${reduceErr.message}`);
      }
    }
    let verificationStatus = "partial";
    let errorMessage;
    if (task.type === "dispatch_council") {
      let successCount = 0;
      let failureCount = 0;
      const failedWorkers = [];
      const reviewsPath = task.output_path;
      for (const role of task.roles) {
        const reviewFile = import_path2.default.join(reviewsPath, `${role}_review.md`);
        const status = verifyOutputPath(reviewFile);
        if (status === "verified") successCount++;
        else {
          failureCount++;
          failedWorkers.push(role);
        }
      }
      if (failureCount === 0) verificationStatus = "verified";
      else if (successCount === 0) {
        verificationStatus = "failed";
        errorMessage = `All ${failureCount} council workers failed: ${failedWorkers.join(", ")}`;
      } else {
        verificationStatus = "partial";
        errorMessage = `${failureCount} of ${task.roles.length} workers failed: ${failedWorkers.join(", ")}. ${successCount} succeeded.`;
      }
      const synthesisPath = import_path2.default.join(task.output_path, "COUNCIL_SYNTHESIS.md");
      if (verificationStatus !== "failed" && !import_fs2.default.existsSync(synthesisPath)) {
        verificationStatus = "failed";
        errorMessage = "COUNCIL_SYNTHESIS.md was not generated";
      }
    } else {
      const status = verifyOutputPath(task.output_path);
      if (status === "partial") verificationStatus = "partial";
      else verificationStatus = status;
    }
    const statusUpdate = { status: verificationStatus };
    if (errorMessage) statusUpdate.error_message = errorMessage;
    TaskManifestManager.updateTask(workspacePath, taskId, statusUpdate);
    console.error(`[Runner] Task ${taskId} finished with status: ${verificationStatus}.`);
    await updateTaskGitHubIssue(workspacePath, taskId, verificationStatus, task.output_path);
  } catch (err) {
    console.error(`[Runner] Task ${taskId} failed:`, err);
    TaskManifestManager.updateTask(workspacePath, taskId, { status: "failed", error_message: err.message });
    await updateTaskGitHubIssue(workspacePath, taskId, "failed", void 0, err.message);
  } finally {
    clearInterval(heartbeatInterval);
    process.exit(0);
  }
}
async function updateTaskGitHubIssue(workspacePath, taskId, status, outputPath, errorMsg) {
  try {
    const manifest = TaskManifestManager.loadManifest(workspacePath);
    const task = manifest[taskId];
    if (!task?.github_issue_number) return;
    const remote = parseGitRemote(workspacePath);
    if (!remote) return;
    const statusEmoji = status === "verified" ? "\u2705" : status === "partial" || status === "degraded" ? "\u26A0\uFE0F" : "\u274C";
    let comment = `## ${statusEmoji} Task Completion Report

`;
    comment += `**Status:** \`${status}\`
`;
    comment += `**Task ID:** \`${taskId}\`
`;
    if (outputPath) comment += `**Output:** \`${outputPath}\`
`;
    if (errorMsg) comment += `**Error:** ${errorMsg}
`;
    comment += agentSignature("council-runner", taskId);
    await commentOnGitHubIssue(remote.owner, remote.repo, task.github_issue_number, comment);
  } catch {
  }
}

// ../src/mcp/mcp-server.ts
var import_child_process3 = require("child_process");
var import_dotenv = __toESM(require("dotenv"));

// ../src/adapters/vcs/VcsProviderFactory.ts
var path6 = __toESM(require("path"));
var fs6 = __toESM(require("fs"));
var crypto = __toESM(require("crypto"));
var import_child_process2 = require("child_process");
var VcsProviderFactory = class {
  static cachedProvider = null;
  static cachedConfigPath = null;
  static cachedConfigHash = null;
  /**
   * Get the appropriate VCS provider for the workspace
   *
   * @param workspacePath - Path to the workspace root
   * @returns Promise resolving to the appropriate VCS provider
   */
  static async getProvider(workspacePath) {
    const resolvedWorkspacePath = workspacePath || process.cwd();
    const configPath = this.getConfigPath(resolvedWorkspacePath);
    const configContent = fs6.existsSync(configPath) ? fs6.readFileSync(configPath, "utf8") : "";
    const configHash = crypto.createHash("md5").update(configContent).digest("hex");
    if (this.cachedProvider && this.cachedConfigPath === configPath && this.cachedConfigHash === configHash) {
      return this.cachedProvider;
    }
    const config = this.loadConfig(resolvedWorkspacePath);
    let providerType = config.provider || "auto-detect";
    if (providerType === "auto-detect") {
      providerType = this.detectProviderFromGitRemote(resolvedWorkspacePath);
    }
    let provider;
    if (providerType === "github") {
      const { owner, repo } = this.getGitHubInfo(config, resolvedWorkspacePath);
      const { GitHubProvider: GitHubProvider2 } = await Promise.resolve().then(() => (init_GitHubProvider(), GitHubProvider_exports));
      provider = new GitHubProvider2(owner, repo);
    } else if (providerType === "azure-devops") {
      const { organization, project } = this.getAdoInfo(config, resolvedWorkspacePath);
      const { AdoProvider: AdoProvider2 } = await Promise.resolve().then(() => (init_AdoProvider(), AdoProvider_exports));
      const adoDefaults = config.ado?.defaults;
      provider = new AdoProvider2(organization, project, adoDefaults);
    } else {
      throw new Error(`Unsupported or undetectable VCS provider: ${providerType}`);
    }
    this.cachedProvider = provider;
    this.cachedConfigPath = configPath;
    this.cachedConfigHash = configHash;
    return provider;
  }
  /**
   * Clear the cached provider (useful for testing or configuration changes)
   */
  static clearCache() {
    this.cachedProvider = null;
    this.cachedConfigPath = null;
    this.cachedConfigHash = null;
  }
  static getConfigPath(workspacePath) {
    return path6.join(workspacePath, ".optimus", "config", "vcs.json");
  }
  static loadConfig(workspacePath) {
    const configPath = this.getConfigPath(workspacePath);
    if (fs6.existsSync(configPath)) {
      try {
        const configContent = fs6.readFileSync(configPath, "utf8");
        return JSON.parse(configContent);
      } catch (error) {
        console.error(`Warning: Failed to parse VCS config at ${configPath}:`, error);
      }
    }
    return { provider: "auto-detect" };
  }
  static detectProviderFromGitRemote(workspacePath) {
    try {
      const remoteUrl = (0, import_child_process2.execSync)("git remote get-url origin", {
        cwd: workspacePath,
        encoding: "utf8"
      }).trim();
      if (remoteUrl.includes("github.com")) {
        return "github";
      }
      if (remoteUrl.includes("dev.azure.com") || remoteUrl.includes("visualstudio.com")) {
        return "azure-devops";
      }
      console.warn(`Unable to detect VCS provider from remote URL: ${remoteUrl}. Defaulting to GitHub.`);
      return "github";
    } catch (error) {
      console.warn("Failed to detect git remote URL. Defaulting to GitHub.");
      return "github";
    }
  }
  static getGitHubInfo(config, workspacePath) {
    if (config.github?.owner && config.github?.repo) {
      return {
        owner: config.github.owner,
        repo: config.github.repo
      };
    }
    try {
      const remoteUrl = (0, import_child_process2.execSync)("git remote get-url origin", {
        cwd: workspacePath,
        encoding: "utf8"
      }).trim();
      const httpsMatch = remoteUrl.match(/github\.com[\/:]+([^\/]+)\/([^\/.]+)/);
      if (httpsMatch) {
        return {
          owner: httpsMatch[1],
          repo: httpsMatch[2]
        };
      }
      throw new Error("Unable to parse GitHub repository info from remote URL");
    } catch (error) {
      throw new Error(
        'Failed to auto-detect GitHub info: git not found in PATH or not a git repository. Set "owner" and "repo" explicitly in .optimus/config/vcs.json'
      );
    }
  }
  static getAdoInfo(config, workspacePath) {
    if (config.ado?.organization && config.ado?.project) {
      return {
        organization: config.ado.organization,
        project: config.ado.project
      };
    }
    try {
      const remoteUrl = (0, import_child_process2.execSync)("git remote get-url origin", {
        cwd: workspacePath,
        encoding: "utf8"
      }).trim();
      let match = remoteUrl.match(/dev\.azure\.com[\/:]([^\/]+)\/([^\/_]+)/);
      if (match) {
        return {
          organization: match[1],
          project: match[2]
        };
      }
      match = remoteUrl.match(/([^.]+)\.visualstudio\.com[\/:]([^\/_]+)/);
      if (match) {
        return {
          organization: match[1],
          project: match[2]
        };
      }
      throw new Error("Unable to parse Azure DevOps repository info from remote URL");
    } catch (error) {
      throw new Error(
        'Failed to auto-detect Azure DevOps info: git not found in PATH or not a git repository. Set "organization" and "project" explicitly in .optimus/config/vcs.json'
      );
    }
  }
  /**
   * Create a provider configuration file in the workspace
   *
   * @param workspacePath - Path to the workspace root
   * @param config - Configuration to save
   */
  static createConfig(workspacePath, config) {
    const configPath = this.getConfigPath(workspacePath);
    const configDir = path6.dirname(configPath);
    if (!fs6.existsSync(configDir)) {
      fs6.mkdirSync(configDir, { recursive: true });
    }
    fs6.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  }
};

// ../src/mcp/mcp-server.ts
function reloadEnv() {
  if (process.env.DOTENV_PATH) {
    import_dotenv.default.config({ path: import_path3.default.resolve(process.env.DOTENV_PATH), override: true });
  } else {
    import_dotenv.default.config({ override: true });
  }
}
reloadEnv();
var server = new import_server.Server(
  {
    name: "optimus-facade",
    version: "1.0.0"
  },
  {
    capabilities: {
      resources: {},
      tools: {}
    }
  }
);
server.setRequestHandler(import_types.ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "optimus://system/instructions",
        name: "Optimus System Instructions",
        description: "Master workflow protocols and agnostic system instructions for Optimus agents.",
        mimeType: "text/markdown"
      }
    ]
  };
});
server.setRequestHandler(import_types.ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "optimus://system/instructions") {
    const workspacePath = process.env.OPTIMUS_WORKSPACE_ROOT || process.cwd();
    const instructionsPath = import_path3.default.resolve(workspacePath, ".optimus", "config", "system-instructions.md");
    if (!instructionsPath.startsWith(import_path3.default.resolve(workspacePath))) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidRequest, `Path traversal detected`);
    }
    try {
      if (import_fs3.default.existsSync(instructionsPath)) {
        const content = import_fs3.default.readFileSync(instructionsPath, "utf8");
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/markdown",
              text: content
            }
          ]
        };
      } else {
        throw new import_types.McpError(import_types.ErrorCode.InvalidRequest, `The system-instructions.md file does not exist at ${instructionsPath}`);
      }
    } catch (e) {
      throw new import_types.McpError(import_types.ErrorCode.InternalError, `Failed to read instructions: ${e.message}`);
    }
  }
  throw new import_types.McpError(import_types.ErrorCode.InvalidRequest, `Resource not found: ${request.params.uri}`);
});
server.setRequestHandler(import_types.ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "append_memory",
        description: "Write experience, architectural decisions, and important project facts into the continuous memory system to evolve the project context.",
        inputSchema: {
          type: "object",
          properties: {
            category: { type: "string", description: "The category of the memory (e.g. 'architecture-decision', 'bug-fix', 'workflow')" },
            tags: { type: "array", items: { type: "string" }, description: "A list of tags for selective loading" },
            content: { type: "string", description: "The actual memory content to solidify" }
          },
          required: ["category", "tags", "content"]
        }
      },
      {
        name: "github_update_issue",
        description: "Updates an existing issue in a GitHub repository (e.g. to close it or add comments).",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "Repository owner" },
            repo: { type: "string", description: "Repository name" },
            issue_number: { type: "number", description: "The number of the issue to update" },
            state: { type: "string", enum: ["open", "closed"], description: "State of the issue" },
            title: { type: "string", description: "New title for the issue" },
            body: { type: "string", description: "New body for the issue (overwrites existing)" },
            agent_role: { type: "string", description: "The role of the agent making this update" },
            session_id: { type: "string", description: "The session ID of the agent" }
          },
          required: ["owner", "repo", "issue_number"]
        }
      },
      {
        name: "github_sync_board",
        description: "Fetches open issues from a GitHub repository and dumps them into the local blackboard.",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "Repository owner (e.g. cloga)" },
            repo: { type: "string", description: "Repository name (e.g. optimus-code)" },
            workspace_path: { type: "string", description: "Absolute workspace path" }
          },
          required: ["owner", "repo", "workspace_path"]
        }
      },
      {
        name: "dispatch_council",
        description: "Trigger a map-reduce multi-expert review for an architectural proposal using the Spartan Swarm protocol.",
        inputSchema: {
          type: "object",
          properties: {
            proposal_path: {
              type: "string",
              description: "The file path to the PROPOSAL.md file"
            },
            roles: {
              type: "array",
              items: { type: "string" },
              description: "An array of expert roles to spawn concurrently (e.g., ['security-expert', 'performance-tyrant'])"
            },
            parent_issue_number: {
              type: "number",
              description: "The GitHub issue number of the parent epic or task. Used for issue lineage tracking."
            }
          },
          required: ["proposal_path", "roles"]
        }
      },
      {
        name: "roster_check",
        description: "Returns a unified directory of all available roles (T1 Local Personas and T2 Global Agents) to help the Master Agent understand current workforce capabilities before dispatching tools.",
        inputSchema: {
          type: "object",
          properties: {
            workspace_path: {
              type: "string",
              description: "The absolute path to the current project workspace to check for T1 local personas."
            }
          },
          required: ["workspace_path"]
        }
      },
      {
        name: "delegate_task",
        description: "Delegate a specific execution task to a designated expert role.",
        inputSchema: {
          type: "object",
          properties: {
            role: {
              type: "string",
              description: "The name of the expert role (e.g., 'chief-architect', 'frontend-dev')."
            },
            role_description: {
              type: "string",
              description: "A short description of what this role does and its expertise (e.g., 'Security auditing expert who reviews code for vulnerabilities and enforces compliance'). Used to generate the T2 role template if the role is new."
            },
            role_engine: {
              type: "string",
              description: "Which execution engine this role should use (e.g., 'claude-code', 'copilot-cli'). Check roster_check for available engines. If omitted, auto-resolved from available-agents.json."
            },
            role_model: {
              type: "string",
              description: "Which model this role should use (e.g., 'claude-opus-4.6-1m', 'gpt-5.4'). If omitted, uses the first available model for the engine."
            },
            task_description: {
              type: "string",
              description: "Detailed description of what the agent needs to do."
            },
            output_path: {
              type: "string",
              description: "The file path where the agent should write its final result or report. If not already under the workspace's .optimus/ directory, it will be automatically scoped to .optimus/results/<filename> within the workspace."
            },
            workspace_path: {
              type: "string",
              description: "Absolute path to the project workspace root."
            },
            context_files: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of workspace-relative paths to design documents, architecture specs, or requirement files that the agent must strictly read before executing the task."
            },
            required_skills: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of skill names this role needs (e.g., ['council-review', 'git-workflow']). If any skill does not exist in .optimus/skills/<name>/SKILL.md, the task will be rejected with a list of missing skills so Master can create them first via a skill-creator delegation."
            },
            parent_issue_number: {
              type: "number",
              description: "The GitHub issue number of the parent epic or task. Used for issue lineage tracking."
            }
          },
          required: ["role", "task_description", "output_path", "workspace_path"]
        }
      },
      {
        name: "delegate_task_async",
        description: "Delegate a specific execution task to a designated expert role asynchronously without blocking the master agent.",
        inputSchema: {
          type: "object",
          properties: {
            role: {
              type: "string",
              description: "The name of the expert role (e.g., 'chief-architect', 'frontend-dev')."
            },
            role_description: {
              type: "string",
              description: "A short description of what this role does and its expertise. Used to generate the T2 role template if the role is new."
            },
            role_engine: {
              type: "string",
              description: "Which execution engine this role should use (e.g., 'claude-code', 'copilot-cli'). If omitted, auto-resolved."
            },
            role_model: {
              type: "string",
              description: "Which model this role should use (e.g., 'claude-opus-4.6-1m'). If omitted, uses default."
            },
            task_description: {
              type: "string",
              description: "Detailed description of what the agent needs to do."
            },
            output_path: {
              type: "string",
              description: "The file path where the agent should write its final result or report."
            },
            workspace_path: {
              type: "string",
              description: "Absolute path to the project workspace root."
            },
            context_files: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of workspace-relative paths to design documents, architecture specs, or requirement files."
            },
            required_skills: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of skill names this role needs. Missing skills will cause rejection so Master can create them first."
            },
            parent_issue_number: {
              type: "number",
              description: "The GitHub issue number of the parent epic or task. Used for issue lineage tracking."
            }
          },
          required: ["role", "task_description", "output_path", "workspace_path"]
        }
      },
      {
        name: "dispatch_council_async",
        description: "Trigger an async map-reduce multi-expert review for an architectural proposal.",
        inputSchema: {
          type: "object",
          properties: {
            proposal_path: {
              type: "string",
              description: "The file path to the PROPOSAL.md file"
            },
            roles: {
              type: "array",
              items: { type: "string" },
              description: "An array of expert roles to spawn concurrently (e.g., ['security-expert', 'performance-tyrant'])"
            },
            workspace_path: {
              type: "string",
              description: "Absolute path to the project workspace root."
            },
            parent_issue_number: {
              type: "number",
              description: "The GitHub issue number of the parent epic or task. Used for issue lineage tracking."
            }
          },
          required: ["proposal_path", "roles", "workspace_path"]
        }
      },
      {
        name: "check_task_status",
        description: "Poll the status of async queues or tasks.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "The ID of the task to check."
            },
            workspace_path: {
              type: "string",
              description: "Absolute path to the project workspace root."
            }
          },
          required: ["taskId", "workspace_path"]
        }
      },
      {
        name: "write_blackboard_artifact",
        description: "Write a file to the .optimus/ blackboard directory. Only paths within .optimus/ are allowed. Use this to create proposals, requirements docs, and other orchestration artifacts. artifact_path is relative to the .optimus/ directory (do NOT include the .optimus/ prefix).",
        inputSchema: {
          type: "object",
          properties: {
            artifact_path: { type: "string", description: "Relative path within .optimus/ directory (e.g. 'proposals/PROPOSAL_xxx.md', 'tasks/requirements_xxx.md'). Do NOT include the '.optimus/' prefix." },
            content: { type: "string", description: "The content to write to the file.", maxLength: 1048576 },
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." }
          },
          required: ["artifact_path", "content", "workspace_path"]
        }
      },
      {
        name: "vcs_create_work_item",
        description: "Create a work item (GitHub Issue or ADO Work Item) using the unified VCS provider.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Work item title" },
            body: { type: "string", description: "Work item description/body (Markdown \u2014 auto-converted to HTML for ADO)" },
            labels: { type: "array", items: { type: "string" }, description: "Labels/tags to apply" },
            work_item_type: { type: "string", description: "ADO work item type (Bug, User Story, Task). Ignored for GitHub." },
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." },
            iteration_path: { type: "string", description: "ADO Sprint/iteration path (e.g. 'Project\\Sprint 1'). Ignored for GitHub." },
            area_path: { type: "string", description: "ADO team/area path (e.g. 'Project\\Team\\Area'). Ignored for GitHub." },
            assigned_to: { type: "string", description: "ADO assigned user (email or alias). Ignored for GitHub." },
            parent_id: { type: "number", description: "ADO parent work item ID for hierarchy linking. Ignored for GitHub." },
            priority: { type: "number", description: "ADO priority (1-4, where 1=Critical). Ignored for GitHub." },
            agent_role: { type: "string", description: "The role of the agent creating this work item. Used for attribution signature." }
          },
          required: ["title", "body", "workspace_path"]
        }
      },
      {
        name: "vcs_create_pr",
        description: "Create a pull request using the unified VCS provider.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "PR title" },
            body: { type: "string", description: "PR description" },
            head: { type: "string", description: "Source branch" },
            base: { type: "string", description: "Target branch" },
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." },
            agent_role: { type: "string", description: "The role of the agent creating this PR. Used for attribution signature." }
          },
          required: ["title", "body", "head", "base", "workspace_path"]
        }
      },
      {
        name: "vcs_merge_pr",
        description: "Merge a pull request using the unified VCS provider.",
        inputSchema: {
          type: "object",
          properties: {
            pull_request_id: { type: ["string", "number"], description: "PR ID or number" },
            commit_title: { type: "string", description: "Merge commit title" },
            merge_method: { type: "string", enum: ["merge", "squash", "rebase"], description: "Merge strategy" },
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." }
          },
          required: ["pull_request_id", "workspace_path"]
        }
      },
      {
        name: "vcs_add_comment",
        description: "Add a comment to a work item or pull request using the unified VCS provider.",
        inputSchema: {
          type: "object",
          properties: {
            item_type: { type: "string", enum: ["workitem", "pullrequest"], description: "Type of item" },
            item_id: { type: ["string", "number"], description: "Work item or PR ID/number" },
            comment: { type: "string", description: "Comment text" },
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." },
            agent_role: { type: "string", description: "The role of the agent posting this comment. Used for attribution signature." }
          },
          required: ["item_type", "item_id", "comment", "workspace_path"]
        }
      },
      {
        name: "hello",
        description: "A simple greeting tool to verify the MCP server is running.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The name to greet" }
          },
          required: ["name"]
        }
      },
      {
        name: "quarantine_role",
        description: "Manually quarantine or unquarantine a T2 role. Quarantined roles cannot be dispatched until unquarantined.",
        inputSchema: {
          type: "object",
          properties: {
            role: { type: "string", description: "The role name to quarantine/unquarantine" },
            action: { type: "string", enum: ["quarantine", "unquarantine"], description: "Whether to quarantine or unquarantine the role" },
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." }
          },
          required: ["role", "action", "workspace_path"]
        }
      }
    ]
  };
});
server.setRequestHandler(import_types.CallToolRequestSchema, async (request) => {
  if (request.params.name === "check_task_status") {
    let { taskId, workspace_path } = request.params.arguments;
    if (!taskId || !workspace_path) throw new Error("Missing taskId or workspace_path");
    TaskManifestManager.reapStaleTasks(workspace_path);
    const manifest = TaskManifestManager.loadManifest(workspace_path);
    const task = manifest[taskId];
    if (!task) {
      return { content: [{ type: "text", text: `Task ${taskId} not found in manifest.` }] };
    }
    let effectiveStatus = task.status;
    let details = "";
    if (task.status === "running") {
      const elapsed = Math.round((Date.now() - task.startTime) / 1e3);
      details = `Task ${taskId} status: **running** (${elapsed}s elapsed)
`;
    } else if (task.status === "verified") {
      details = `Task ${taskId} status: **verified** \u2705

Output verified at ${task.output_path || "the review path"}.`;
      if (task.type === "dispatch_council") {
        const verdictPath = import_path3.default.join(task.output_path, "VERDICT.md");
        if (import_fs3.default.existsSync(verdictPath)) {
          details += `
PM Verdict available at: ${verdictPath}`;
        }
      }
    } else if (task.status === "completed") {
      let outputExists = false;
      if (task.output_path) {
        try {
          const stat = import_fs3.default.statSync(task.output_path);
          outputExists = stat.isFile() ? stat.size > 0 : import_fs3.default.readdirSync(task.output_path).length > 0;
        } catch {
        }
      }
      effectiveStatus = outputExists ? "verified" : "partial";
      if (effectiveStatus === "verified") {
        details = `Task ${taskId} status: **verified** \u2705

Output is ready at ${task.output_path}.`;
      } else {
        details = `Task ${taskId} status: **partial** \u26A0\uFE0F

Process exited successfully but output_path is missing or empty: \`${task.output_path}\``;
      }
    } else if (task.status === "partial") {
      details = `Task ${taskId} status: **partial** \u26A0\uFE0F

Process exited successfully but output artifact was not found at: \`${task.output_path}\``;
    } else if (task.status === "failed") {
      details = `Task ${taskId} status: **failed** \u274C

Error: ${task.error_message}`;
    } else {
      details = `Task ${taskId} status: **${task.status}**`;
    }
    return { content: [{ type: "text", text: details }] };
  }
  if (request.params.name === "delegate_task_async") {
    let { role, role_description, role_engine, role_model, task_description, output_path, workspace_path, context_files, required_skills } = request.params.arguments;
    if (!role || !task_description || !output_path || !workspace_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments");
    }
    if (role_engine || role_model) {
      const { engines: ve2, models: vm } = loadValidEnginesAndModels(workspace_path);
      if (role_engine && !isValidEngine(role_engine, ve2)) {
        console.error(`[T2 Guard] Rejected invalid engine '${role_engine}' for role '${role}'. Valid: ${ve2.join(", ")}`);
        role_engine = void 0;
        role_model = void 0;
      } else if (role_model && role_engine && !isValidModel(role_model, role_engine, vm)) {
        console.error(`[T2 Guard] Rejected invalid model '${role_model}' for engine '${role_engine}' on role '${role}'. Valid: ${(vm[role_engine] || []).join(", ")}`);
        role_model = void 0;
      }
    }
    const rawParentAsync = process.env.OPTIMUS_PARENT_ISSUE ? parseInt(process.env.OPTIMUS_PARENT_ISSUE, 10) : void 0;
    const parentIssueNumber = request.params.arguments.parent_issue_number ?? (Number.isNaN(rawParentAsync) ? void 0 : rawParentAsync);
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    TaskManifestManager.createTask(workspace_path, {
      taskId,
      type: "delegate_task",
      role,
      task_description,
      output_path,
      workspacePath: workspace_path,
      context_files: context_files || [],
      role_description,
      role_engine,
      role_model,
      required_skills,
      delegation_depth: parseInt(process.env.OPTIMUS_DELEGATION_DEPTH || "0", 10),
      parent_issue_number: parentIssueNumber
    });
    let issueInfo = "";
    const remote = parseGitRemote(workspace_path);
    if (remote) {
      const truncDesc = task_description.length > 300 ? task_description.substring(0, 300) + "..." : task_description;
      const shortTitle = task_description.split("\n")[0].substring(0, 80).trim();
      const parentRef = parentIssueNumber ? `**Parent Epic:** #${parentIssueNumber}

` : "";
      const issue = await createGitHubIssue(
        remote.owner,
        remote.repo,
        `[Task] ${role}: ${shortTitle}...`,
        `${parentRef}## Auto-generated Swarm Task Tracker

**Task ID:** \`${taskId}\`
**Role:** \`${role}\`
**Output Path:** \`${output_path}\`

### Task Description
${truncDesc}` + agentSignature(role, taskId),
        ["swarm-task", "optimus-bot"]
      );
      if (issue) {
        TaskManifestManager.updateTask(workspace_path, taskId, { github_issue_number: issue.number });
        issueInfo = `
**GitHub Issue**: ${issue.html_url}`;
      }
    }
    const child = (0, import_child_process3.spawn)(process.execPath, [__filename, "--run-task", taskId, workspace_path], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return { content: [{ type: "text", text: `\u2705 Task spawned successfully in background.

**Task ID**: ${taskId}
**Role**: ${role}${issueInfo}

Use check_task_status tool periodically with this task ID to check its completion.` }] };
  }
  if (request.params.name === "dispatch_council_async") {
    let { proposal_path, roles, workspace_path } = request.params.arguments;
    if (!proposal_path || !Array.isArray(roles) || !workspace_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments");
    }
    const rawParentAsync2 = process.env.OPTIMUS_PARENT_ISSUE ? parseInt(process.env.OPTIMUS_PARENT_ISSUE, 10) : void 0;
    const parentIssueNumber = request.params.arguments.parent_issue_number ?? (Number.isNaN(rawParentAsync2) ? void 0 : rawParentAsync2);
    const taskId = `council_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const reviewsPath = import_path3.default.join(workspace_path, ".optimus", "reviews", taskId);
    TaskManifestManager.createTask(workspace_path, {
      taskId,
      type: "dispatch_council",
      roles,
      proposal_path,
      output_path: reviewsPath,
      workspacePath: workspace_path,
      delegation_depth: parseInt(process.env.OPTIMUS_DELEGATION_DEPTH || "0", 10),
      parent_issue_number: parentIssueNumber
    });
    let issueInfo = "";
    const remote = parseGitRemote(workspace_path);
    if (remote) {
      const proposalName = require("path").basename(proposal_path, ".md").replace(/^PROPOSAL_/i, "").replace(/[_-]/g, " ");
      const parentRef = parentIssueNumber ? `**Parent Epic:** #${parentIssueNumber}

` : "";
      const issue = await createGitHubIssue(
        remote.owner,
        remote.repo,
        `[Council] ${proposalName} (Review)`,
        `${parentRef}## Auto-generated Council Review Tracker

**Council ID:** \`${taskId}\`
**Roles:** ${roles.map((r) => `\`${r}\``).join(", ")}
**Proposal:** \`${proposal_path}\`
**Reviews Path:** \`${reviewsPath}\`` + agentSignature("council-orchestrator", taskId),
        ["swarm-council", "optimus-bot"]
      );
      if (issue) {
        TaskManifestManager.updateTask(workspace_path, taskId, { github_issue_number: issue.number });
        issueInfo = `
**GitHub Issue**: ${issue.html_url}`;
      }
    }
    const child = (0, import_child_process3.spawn)(process.execPath, [__filename, "--run-task", taskId, workspace_path], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return { content: [{ type: "text", text: `\u2705 Council spawned successfully in background.

**Council ID**: ${taskId}
**Roles**: ${roles.join(", ")}${issueInfo}

Use check_task_status tool periodically with this Council ID to check completion.` }] };
  }
  if (request.params.name === "dispatch_council") {
    let { proposal_path, roles, workspace_path } = request.params.arguments;
    if (!proposal_path || !Array.isArray(roles) || roles.length === 0) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments: requires proposal_path and an array of roles");
    }
    const rawParentSync = process.env.OPTIMUS_PARENT_ISSUE ? parseInt(process.env.OPTIMUS_PARENT_ISSUE, 10) : void 0;
    const parentIssueNumber = request.params.arguments.parent_issue_number ?? (Number.isNaN(rawParentSync) ? void 0 : rawParentSync);
    let workspacePath;
    const optimusIndex = proposal_path.indexOf(".optimus");
    if (optimusIndex !== -1) {
      workspacePath = proposal_path.substring(0, optimusIndex);
    } else {
      workspacePath = import_path3.default.resolve(import_path3.default.dirname(proposal_path));
    }
    const timestampId = Date.now();
    const reviewsPath = import_path3.default.join(workspacePath, ".optimus", "reviews", timestampId.toString());
    import_fs3.default.mkdirSync(reviewsPath, { recursive: true });
    console.error(`[MCP] Dispatching council with roles: ${roles.join(", ")}`);
    const results = await dispatchCouncilConcurrent(roles, proposal_path, reviewsPath, timestampId.toString(), workspacePath, void 0, parentIssueNumber);
    return {
      content: [
        {
          type: "text",
          text: `\u2696\uFE0F **Council Map-Reduce Review Completed**
All expert workers executed parallelly adhering to the Singleton Worker Rule.

Reviews are saved in isolated path: \`${reviewsPath}\`

Execution Logs:
${results.join("\n")}

Please read these review files to continue.`
        }
      ]
    };
  } else if (request.params.name === "append_memory") {
    let { category, tags, content } = request.params.arguments;
    const workspacePath = process.env.OPTIMUS_WORKSPACE_ROOT || process.cwd();
    const memoryDir = import_path3.default.resolve(workspacePath, ".optimus", "memory");
    const memoryFile = import_path3.default.join(memoryDir, "continuous-memory.md");
    if (!import_fs3.default.existsSync(memoryDir)) {
      import_fs3.default.mkdirSync(memoryDir, { recursive: true });
    }
    if (!global.memoryLock) {
      global.memoryLock = Promise.resolve();
    }
    try {
      await global.memoryLock;
      const writePromise = new Promise((resolve, reject) => {
        try {
          const timestamp = (/* @__PURE__ */ new Date()).toISOString();
          const memoryId = "mem_" + Date.now() + "_" + Math.floor(Math.random() * 1e3);
          const freshEntry = [
            "---",
            "id: " + memoryId,
            "category: " + (category || "uncategorized"),
            "tags: [" + (tags ? tags.join(", ") : "") + "]",
            "created: " + timestamp,
            "---",
            content,
            "\n"
          ].join("\n");
          import_fs3.default.appendFileSync(memoryFile, freshEntry, "utf8");
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      global.memoryLock = writePromise;
      await writePromise;
      return {
        content: [
          {
            type: "text",
            text: `\u2705 Experience solidifed to memory!
Tags: ${tags.join(", ")}
Memory appended to: ${memoryFile}`
          }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to append memory: ${err.message}` }],
        isError: true
      };
    }
  } else if (request.params.name === "roster_check") {
    const { workspace_path } = request.params.arguments;
    if (!workspace_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments: requires workspace_path");
    }
    const t1Dir = import_path3.default.join(workspace_path, ".optimus", "agents");
    const t2Dir = import_path3.default.join(workspace_path, ".optimus", "roles");
    if (!import_fs3.default.existsSync(t2Dir)) {
      import_fs3.default.mkdirSync(t2Dir, { recursive: true });
    }
    let roster = "\u{1F4CB} **Spartan Swarm Active Roster**\n\n";
    roster += "### T1: Local Project Experts\n";
    if (import_fs3.default.existsSync(t1Dir)) {
      const t1Files = import_fs3.default.readdirSync(t1Dir).filter((f) => f.endsWith(".md"));
      roster += t1Files.length > 0 ? t1Files.map((f) => `- ${f.replace(".md", "")}`).join("\n") : "(No local overrides found)\n";
    } else {
      roster += "(No local personas directory found)\n";
    }
    const configPath = import_path3.default.join(workspace_path, ".optimus", "config", "available-agents.json");
    if (import_fs3.default.existsSync(configPath)) {
      try {
        const config = JSON.parse(import_fs3.default.readFileSync(configPath, "utf8"));
        roster += "\n### \u2699\uFE0F Engine & Model Spec (T3 configuration)\n";
        roster += "**Available Execution Engines (Toolchains & Supported Models)**:\n";
        Object.keys(config.engines).forEach((engine) => {
          const statusMatch = config.engines[engine].status ? ` *[Status: ${config.engines[engine].status}]*` : "";
          roster += `- [Engine: ${engine}] Models: [${config.engines[engine].available_models.join(", ")}]${statusMatch}
`;
        });
        roster += "*Note: Append these engine and model combinations to role names to spawn customized variants. Examples: `chief-architect_claude-code_claude-3-opus`, `security-auditor_copilot-cli_o1-preview`.*\n\n";
      } catch (e) {
      }
    }
    roster += "\n## \u{1F465} Roles \u2014 WHO does the work\n";
    const t2RoleNames = [];
    if (import_fs3.default.existsSync(t2Dir)) {
      const t2Files = import_fs3.default.readdirSync(t2Dir).filter((f) => f.endsWith(".md"));
      if (t2Files.length > 0) {
        for (const f of t2Files) {
          const roleName = f.replace(".md", "");
          t2RoleNames.push(roleName);
          try {
            const content = import_fs3.default.readFileSync(import_path3.default.join(t2Dir, f), "utf8");
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let engineInfo = "";
            let quarantineMarker = "";
            if (fmMatch) {
              const lines = fmMatch[1].split("\n");
              const engineLine = lines.find((l) => l.startsWith("engine:"));
              const modelLine = lines.find((l) => l.startsWith("model:"));
              const statusLine = lines.find((l) => l.startsWith("status:"));
              if (engineLine || modelLine) {
                const engine = engineLine ? engineLine.split(":")[1].trim() : "?";
                const model = modelLine ? modelLine.split(":")[1].trim() : "?";
                engineInfo = ` \u2192 \`${engine}\` / \`${model}\``;
              }
              if (statusLine && statusLine.split(":")[1].trim() === "quarantined") {
                quarantineMarker = " **[QUARANTINED]**";
              }
            }
            roster += `- ${roleName}${engineInfo}${quarantineMarker}
`;
          } catch {
            roster += `- ${roleName}
`;
          }
        }
      } else {
        roster += "(No project default roles found)\n";
      }
    } else {
      roster += "(No project roles directory found)\n";
    }
    const t3LogPath = import_path3.default.join(workspace_path, ".optimus", "state", "t3-usage-log.json");
    if (import_fs3.default.existsSync(t3LogPath)) {
      try {
        const t3Log = JSON.parse(import_fs3.default.readFileSync(t3LogPath, "utf8"));
        const entries = Object.values(t3Log);
        if (entries.length > 0) {
          roster += "\n### \u{1F4CA} T3 Dynamic Role Usage Stats\n";
          for (const e of entries) {
            const rate = e.invocations > 0 ? Math.round(e.successes / e.invocations * 100) : 0;
            roster += `- \`${e.role}\`: ${e.invocations} invocations (${rate}% success)
`;
          }
        }
      } catch {
      }
    }
    roster += "\n### \u2699\uFE0F Fallback Behavior\n";
    roster += "- If no roles/agents exist, the system defaults to **PM (Master Agent)** behavior.\n";
    roster += "- If a role has no `engine`/`model` in frontmatter, the system auto-resolves from `available-agents.json`, or falls back to `claude-code`.\n";
    roster += "- T3 roles auto-precipitate to T2 immediately on first use.\n";
    const skillsDir = import_path3.default.join(workspace_path, ".optimus", "skills");
    if (import_fs3.default.existsSync(skillsDir)) {
      const skillDirs = import_fs3.default.readdirSync(skillsDir).filter((d) => {
        try {
          return import_fs3.default.statSync(import_path3.default.join(skillsDir, d)).isDirectory() && import_fs3.default.existsSync(import_path3.default.join(skillsDir, d, "SKILL.md"));
        } catch {
          return false;
        }
      });
      if (skillDirs.length > 0) {
        roster += "\n## \u{1F4DA} Skills \u2014 HOW to do the work\n";
        roster += "Use `required_skills` in `delegate_task` to equip agents with these skills:\n";
        for (const skill of skillDirs) {
          try {
            const content = import_fs3.default.readFileSync(import_path3.default.join(skillsDir, skill, "SKILL.md"), "utf8");
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let desc = "";
            let isAutoGenerated = false;
            if (fmMatch) {
              const descLine = fmMatch[1].split("\n").find((l) => l.startsWith("description:"));
              if (descLine) desc = " \u2014 " + descLine.split(":").slice(1).join(":").trim().replace(/^['"]|['"]$/g, "");
              const autoGenLine = fmMatch[1].split("\n").find((l) => l.startsWith("auto_generated:"));
              if (autoGenLine && autoGenLine.split(":")[1].trim() === "true") isAutoGenerated = true;
            }
            const isMeta = skill === "agent-creator" || skill === "skill-creator";
            const nameCollision = t2RoleNames.includes(skill) ? " \u26A0\uFE0F name matches a role" : "";
            const autoTag = isAutoGenerated ? " (auto-generated)" : "";
            roster += `- ${isMeta ? "\u{1F9EC} " : ""}\`${skill}\`${desc}${autoTag}${nameCollision}
`;
          } catch {
            roster += `- \`${skill}\`
`;
          }
        }
      }
    }
    roster += "\n> \u2139\uFE0F Roles and Skills are independent (many-to-many). Equip skills via `required_skills` parameter in `delegate_task`.\n";
    return {
      content: [{ type: "text", text: roster }]
    };
  } else if (request.params.name === "delegate_task") {
    let { role, role_description, role_engine, role_model, task_description, output_path, context_files, required_skills } = request.params.arguments;
    let workspace_path = request.params.arguments.workspace_path;
    const rawParentSync = process.env.OPTIMUS_PARENT_ISSUE ? parseInt(process.env.OPTIMUS_PARENT_ISSUE, 10) : void 0;
    const parentIssueNumber = request.params.arguments.parent_issue_number ?? (Number.isNaN(rawParentSync) ? void 0 : rawParentSync);
    if (!role || !task_description || !output_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments: requires role, task_description, output_path");
    }
    if (!workspace_path) {
      workspace_path = process.cwd();
      if (output_path.includes("optimus-code")) {
        workspace_path = output_path.split("optimus-code")[0] + "optimus-code";
      }
    }
    if (role_engine || role_model) {
      const { engines: ve2, models: vm } = loadValidEnginesAndModels(workspace_path);
      if (role_engine && !isValidEngine(role_engine, ve2)) {
        console.error(`[T2 Guard] Rejected invalid engine '${role_engine}' for role '${role}'. Valid: ${ve2.join(", ")}`);
        role_engine = void 0;
        role_model = void 0;
      } else if (role_model && role_engine && !isValidModel(role_model, role_engine, vm)) {
        console.error(`[T2 Guard] Rejected invalid model '${role_model}' for engine '${role_engine}' on role '${role}'. Valid: ${(vm[role_engine] || []).join(", ")}`);
        role_model = void 0;
      }
    }
    const sessionId = import_crypto.default.randomUUID();
    const workspacePath = workspace_path;
    const optimusDir = import_path3.default.join(workspacePath, ".optimus");
    const resolvedOutputPath = import_path3.default.resolve(workspacePath, output_path);
    const canonicalOutputPath = resolvedOutputPath.startsWith(optimusDir) ? resolvedOutputPath : import_path3.default.join(optimusDir, "results", import_path3.default.basename(output_path));
    const tasksDir = import_path3.default.join(workspacePath, ".optimus", "tasks");
    import_fs3.default.mkdirSync(tasksDir, { recursive: true });
    const taskArtifactPath = import_path3.default.join(tasksDir, `task_${sessionId}.md`);
    import_fs3.default.writeFileSync(taskArtifactPath, task_description, "utf8");
    import_fs3.default.mkdirSync(import_path3.default.dirname(canonicalOutputPath), { recursive: true });
    console.error(`[MCP] Delegating task to role: ${role}, output scoped to: ${canonicalOutputPath}`);
    const result = await delegateTaskSingle(role, taskArtifactPath, canonicalOutputPath, sessionId, workspacePath, context_files, { description: role_description, engine: role_engine, model: role_model, requiredSkills: required_skills }, void 0, parentIssueNumber);
    return {
      content: [{ type: "text", text: result }]
    };
  } else if (request.params.name === "vcs_create_work_item") {
    const {
      title,
      body,
      labels,
      work_item_type,
      workspace_path,
      iteration_path,
      area_path,
      assigned_to,
      parent_id,
      priority,
      agent_role
    } = request.params.arguments;
    if (!title || !body || !workspace_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments: requires title, body, and workspace_path");
    }
    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const finalBody = agent_role ? body + agentSignature(agent_role) : body;
      const result = await vcsProvider.createWorkItem(title, finalBody, labels, work_item_type, {
        iteration_path,
        area_path,
        assigned_to,
        parent_id,
        priority
      });
      return {
        content: [{
          type: "text",
          text: `\u2705 Work item created successfully on ${vcsProvider.getProviderName()}

**Title:** ${result.title}
**ID:** ${result.id}${result.number ? `
**Number:** ${result.number}` : ""}
**URL:** ${result.url}`
        }]
      };
    } catch (error) {
      throw new import_types.McpError(import_types.ErrorCode.InternalError, `Failed to create work item: ${error.message}`);
    }
  } else if (request.params.name === "vcs_create_pr") {
    const { title, body, head, base, workspace_path, agent_role } = request.params.arguments;
    if (!title || !body || !head || !base || !workspace_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments: requires title, body, head, base, and workspace_path");
    }
    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const finalBody = agent_role ? body + agentSignature(agent_role) : body;
      const result = await vcsProvider.createPullRequest(title, finalBody, head, base);
      return {
        content: [{
          type: "text",
          text: `\u2705 Pull request created successfully on ${vcsProvider.getProviderName()}

**Title:** ${result.title}
**Number:** ${result.number}
**ID:** ${result.id}
**URL:** ${result.url}`
        }]
      };
    } catch (error) {
      throw new import_types.McpError(import_types.ErrorCode.InternalError, `Failed to create pull request: ${error.message}`);
    }
  } else if (request.params.name === "vcs_merge_pr") {
    const { pull_request_id, commit_title, merge_method, workspace_path } = request.params.arguments;
    if (!pull_request_id || !workspace_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments: requires pull_request_id and workspace_path");
    }
    const PROTECTED_BRANCHES = ["master", "main", "develop", "release"];
    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const result = await vcsProvider.mergePullRequest(pull_request_id, commit_title, merge_method);
      if (!result.merged) {
        return {
          content: [{
            type: "text",
            text: `\u274C Failed to merge pull request #${pull_request_id} on ${vcsProvider.getProviderName()}`
          }]
        };
      }
      let branchCleanupMsg = "";
      if (result.headBranch && !PROTECTED_BRANCHES.includes(result.headBranch)) {
        try {
          const currentBranch = (0, import_child_process3.execSync)("git rev-parse --abbrev-ref HEAD", { cwd: workspace_path, encoding: "utf8" }).trim();
          if (currentBranch === result.headBranch) {
            const checkoutTarget = result.baseBranch || "master";
            (0, import_child_process3.execSync)(`git checkout ${checkoutTarget}`, { cwd: workspace_path, encoding: "utf8" });
          }
          (0, import_child_process3.execSync)(`git branch -d ${result.headBranch}`, { cwd: workspace_path, encoding: "utf8" });
          branchCleanupMsg = ` Branch '${result.headBranch}' cleaned up.`;
          console.error(`[Branch Cleanup] Deleted branch '${result.headBranch}' after merging PR #${pull_request_id}`);
        } catch (cleanupErr) {
          branchCleanupMsg = ` \u26A0\uFE0F Branch cleanup warning: ${cleanupErr.message}`;
          console.error(`[Branch Cleanup] Warning: ${cleanupErr.message}`);
        }
      }
      let syncMsg = "";
      try {
        const syncBranch = result.baseBranch || "master";
        const currentBranchAfterCleanup = (0, import_child_process3.execSync)("git rev-parse --abbrev-ref HEAD", { cwd: workspace_path, encoding: "utf8" }).trim();
        if (currentBranchAfterCleanup !== syncBranch) {
          (0, import_child_process3.execSync)(`git checkout ${syncBranch}`, { cwd: workspace_path, encoding: "utf8" });
        }
        (0, import_child_process3.execSync)(`git pull --rebase origin ${syncBranch}`, { cwd: workspace_path, encoding: "utf8" });
        syncMsg = ` Local '${syncBranch}' synced.`;
      } catch (syncErr) {
        console.error(`[Post-Merge Sync] Warning: ${syncErr.message}`);
      }
      return {
        content: [{
          type: "text",
          text: `\u2705 Pull request #${pull_request_id} merged successfully on ${vcsProvider.getProviderName()}.${branchCleanupMsg}${syncMsg}`
        }]
      };
    } catch (error) {
      throw new import_types.McpError(import_types.ErrorCode.InternalError, `Failed to merge pull request: ${error.message}`);
    }
  } else if (request.params.name === "vcs_add_comment") {
    const { item_type, item_id, comment, workspace_path, agent_role } = request.params.arguments;
    if (!item_type || !item_id || !comment || !workspace_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments: requires item_type, item_id, comment, and workspace_path");
    }
    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const finalComment = agent_role ? comment + agentSignature(agent_role) : comment;
      const result = await vcsProvider.addComment(item_type, item_id, finalComment);
      return {
        content: [{
          type: "text",
          text: `\u2705 Comment added successfully to ${item_type} #${item_id} on ${vcsProvider.getProviderName()}

**Comment ID:** ${result.id}
**URL:** ${result.url}`
        }]
      };
    } catch (error) {
      throw new import_types.McpError(import_types.ErrorCode.InternalError, `Failed to add comment: ${error.message}`);
    }
  } else if (request.params.name === "write_blackboard_artifact") {
    const { artifact_path, content, workspace_path } = request.params.arguments;
    if (!artifact_path || content === void 0 || content === null || !workspace_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Missing required parameters: artifact_path, content, workspace_path");
    }
    const optimusRoot = import_path3.default.resolve(workspace_path, ".optimus");
    const resolvedTarget = import_path3.default.resolve(optimusRoot, artifact_path);
    if (!resolvedTarget.startsWith(optimusRoot + import_path3.default.sep) && resolvedTarget !== optimusRoot) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "artifact_path must resolve to within .optimus/ directory. Path traversal detected.");
    }
    let existingPath = resolvedTarget;
    let suffix = "";
    while (!import_fs3.default.existsSync(existingPath)) {
      suffix = import_path3.default.join(import_path3.default.basename(existingPath), suffix);
      existingPath = import_path3.default.dirname(existingPath);
    }
    const realExisting = import_fs3.default.realpathSync(existingPath);
    const realTarget = import_path3.default.join(realExisting, suffix);
    const realOptimus = import_fs3.default.existsSync(optimusRoot) ? import_fs3.default.realpathSync(optimusRoot) : optimusRoot;
    if (!realTarget.startsWith(realOptimus + import_path3.default.sep) && realTarget !== realOptimus) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "artifact_path resolves outside .optimus/ via symlink. Path traversal detected.");
    }
    try {
      import_fs3.default.mkdirSync(import_path3.default.dirname(resolvedTarget), { recursive: true });
      import_fs3.default.writeFileSync(resolvedTarget, content, "utf8");
      return { content: [{ type: "text", text: `Artifact written to: ${resolvedTarget}` }] };
    } catch (error) {
      throw new import_types.McpError(import_types.ErrorCode.InternalError, `Failed to write artifact: ${error.message}`);
    }
  } else if (request.params.name === "hello") {
    const { name } = request.params.arguments;
    if (!name) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Missing required parameter: name");
    }
    return { content: [{ type: "text", text: `Hello, ${name}! Optimus Swarm is running.` }] };
  } else if (request.params.name === "quarantine_role") {
    const { role, action, workspace_path } = request.params.arguments;
    if (!role || !action || !workspace_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Missing required parameters: role, action, workspace_path");
    }
    const t2Dir = import_path3.default.join(workspace_path, ".optimus", "roles");
    const rolePath = import_path3.default.join(t2Dir, `${role}.md`);
    if (!import_fs3.default.existsSync(rolePath)) {
      return { content: [{ type: "text", text: `Role '${role}' not found at ${rolePath}` }] };
    }
    const content = import_fs3.default.readFileSync(rolePath, "utf8");
    if (action === "quarantine") {
      const updated = updateFrontmatter(content, {
        status: "quarantined",
        quarantined_at: (/* @__PURE__ */ new Date()).toISOString()
      });
      import_fs3.default.writeFileSync(rolePath, updated, "utf8");
      const log = loadT3UsageLog(workspace_path);
      if (log[role]) {
        log[role].consecutive_failures = 0;
        saveT3UsageLog(workspace_path, log);
      }
      return { content: [{ type: "text", text: `Role '${role}' has been quarantined. It will be blocked from dispatch until unquarantined.` }] };
    } else if (action === "unquarantine") {
      const updated = updateFrontmatter(content, {
        status: "idle",
        quarantined_at: ""
      });
      import_fs3.default.writeFileSync(rolePath, updated, "utf8");
      const log = loadT3UsageLog(workspace_path);
      if (log[role]) {
        log[role].consecutive_failures = 0;
        saveT3UsageLog(workspace_path, log);
      }
      return { content: [{ type: "text", text: `Role '${role}' has been unquarantined and is available for dispatch again.` }] };
    } else {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, `Invalid action '${action}'. Must be 'quarantine' or 'unquarantine'.`);
    }
  }
  throw new import_types.McpError(import_types.ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
});
if (process.argv.includes("--run-task")) {
  const idx = process.argv.indexOf("--run-task");
  const taskId = process.argv[idx + 1];
  const workspacePath = process.argv[idx + 2];
  if (!taskId || !workspacePath) {
    console.error("[Runner] Usage: --run-task <taskId> <workspacePath>");
    process.exit(1);
  }
  runAsyncWorker(taskId, workspacePath).catch((err) => {
    console.error("[Runner] Fatal:", err);
    process.exit(1);
  });
} else {
  async function main() {
    const transport = new import_stdio.StdioServerTransport();
    await server.connect(transport);
    console.error("Optimus Spartan Swarm MCP server running on stdio");
    const workspaceRoot = process.env.OPTIMUS_WORKSPACE_ROOT || process.cwd();
    try {
      cleanStaleAgents(workspaceRoot);
    } catch (e) {
      console.error(`[Agent GC] Warning: ${e.message}`);
    }
  }
  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
//# sourceMappingURL=mcp-server.js.map
