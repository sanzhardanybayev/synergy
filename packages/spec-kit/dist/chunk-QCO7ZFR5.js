// src/components/Status.tsx
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var ALL_STATUSES = [
  "draft",
  "proposed",
  "in-progress",
  "blocked",
  "done",
  "shipped"
];
var labelFor = {
  draft: "Draft",
  proposed: "Proposed",
  "in-progress": "In progress",
  blocked: "Blocked",
  done: "Done",
  shipped: "Shipped"
};
function Status({ value, note, editable = false, dirty = false, onChange }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const closePopover = useCallback(() => {
    setOpen(false);
  }, []);
  const handleSelect = useCallback(
    (next) => {
      closePopover();
      onChange?.(next);
    },
    [closePopover, onChange]
  );
  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Escape") {
        closePopover();
      }
    },
    [closePopover]
  );
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        closePopover();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open, closePopover]);
  const dot = /* @__PURE__ */ jsx("span", { className: "sk-status__dot", "aria-hidden": true });
  const label = /* @__PURE__ */ jsx("span", { className: "sk-status__label", children: labelFor[value] });
  const pendingIndicator = dirty ? /* @__PURE__ */ jsx("span", { className: "sk-status__pending", "aria-label": "pending change" }) : null;
  const noteEl = note ? /* @__PURE__ */ jsxs("span", { className: "sk-status__note", children: [
    "\u2014 ",
    note
  ] }) : null;
  if (!editable) {
    return /* @__PURE__ */ jsxs("span", { className: clsx("sk-status", `sk-status--${value}`), "data-status": value, children: [
      dot,
      label,
      pendingIndicator,
      noteEl
    ] });
  }
  return /* @__PURE__ */ jsxs("span", { ref: containerRef, className: "sk-status-container", onKeyDown: handleKeyDown, children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        className: clsx("sk-status", `sk-status--${value}`, "sk-status--editable"),
        "data-status": value,
        "aria-haspopup": "listbox",
        "aria-expanded": open,
        onClick: () => setOpen((prev) => !prev),
        children: [
          dot,
          label,
          pendingIndicator,
          noteEl
        ]
      }
    ),
    open ? (
      // biome-ignore lint/a11y/useSemanticElements: styled popover requires role="listbox" on a div; native <select> cannot be used here
      // biome-ignore lint/a11y/useFocusableInteractive: focus is managed by the trigger button; options are individually focusable
      /* @__PURE__ */ jsx("div", { className: "sk-status-popover", role: "listbox", "aria-label": "Select status", tabIndex: -1, children: ALL_STATUSES.map((s) => /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          role: "option",
          "aria-selected": s === value,
          className: clsx(
            "sk-status-popover__option",
            s === value && "sk-status-popover__option--selected"
          ),
          onClick: () => handleSelect(s),
          children: [
            /* @__PURE__ */ jsx(
              "span",
              {
                className: clsx("sk-status__dot", `sk-status-popover__dot--${s}`),
                "aria-hidden": true
              }
            ),
            /* @__PURE__ */ jsx("span", { children: labelFor[s] })
          ]
        },
        s
      )) })
    ) : null
  ] });
}

// src/components/Phase.tsx
import clsx2 from "clsx";

// src/ExecutionState.tsx
import { createContext, useContext } from "react";
import { jsx as jsx2 } from "react/jsx-runtime";
var EMPTY = {
  phases: {},
  roster: [],
  derived: { done: 0, total: 0, percent: 0 }
};
var ExecutionStateContext = createContext(EMPTY);
function useExecutionState() {
  return useContext(ExecutionStateContext);
}
function ExecutionStateProvider({
  value,
  children
}) {
  return /* @__PURE__ */ jsx2(ExecutionStateContext.Provider, { value, children });
}

// src/components/Phase.tsx
import { jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
function Phase({
  number,
  title,
  id,
  status,
  summary,
  estimate,
  editable = false,
  statusDirty = false,
  onStatusChange,
  children
}) {
  const exec = useExecutionState();
  const live = id ? exec.phases[id] : void 0;
  const effectiveStatus = live?.status ?? status;
  return /* @__PURE__ */ jsxs2("section", { className: clsx2("sk-phase"), "data-phase": number, "data-phase-id": id, children: [
    /* @__PURE__ */ jsxs2("header", { className: "sk-phase__header", children: [
      /* @__PURE__ */ jsxs2("span", { className: "sk-phase__number", children: [
        "Phase ",
        number
      ] }),
      /* @__PURE__ */ jsx3("h3", { className: "sk-phase__title", children: title }),
      /* @__PURE__ */ jsxs2("div", { className: "sk-phase__meta", children: [
        effectiveStatus ? /* @__PURE__ */ jsx3(
          Status,
          {
            value: effectiveStatus,
            editable,
            dirty: statusDirty,
            onChange: onStatusChange
          }
        ) : null,
        estimate ? /* @__PURE__ */ jsxs2("span", { className: "sk-phase__estimate", children: [
          "\u23F1 ",
          estimate
        ] }) : null
      ] })
    ] }),
    summary ? /* @__PURE__ */ jsx3("p", { className: "sk-phase__summary", children: summary }) : null,
    live?.latestFinding ? /* @__PURE__ */ jsx3("p", { className: "sk-phase__finding", "data-testid": "phase-finding", children: live.latestFinding }) : null,
    children ? /* @__PURE__ */ jsx3("div", { className: "sk-phase__body", children }) : null
  ] });
}

// src/components/Timeline.tsx
import clsx3 from "clsx";
import { jsx as jsx4, jsxs as jsxs3 } from "react/jsx-runtime";
function Timeline({ milestones, caption, children }) {
  const { roster = [], derived } = useExecutionState();
  if (!milestones) {
    if (roster.length === 0) return null;
    const percent = derived?.percent ?? 0;
    return /* @__PURE__ */ jsxs3("figure", { className: "sk-timeline sk-timeline--phases", children: [
      caption ? /* @__PURE__ */ jsx4("figcaption", { className: "sk-timeline__caption", children: caption }) : null,
      /* @__PURE__ */ jsx4("div", { className: "sk-timeline__bar", "aria-hidden": "true", children: /* @__PURE__ */ jsx4(
        "div",
        {
          className: "sk-timeline__fill",
          "data-testid": "timeline-bar-fill",
          style: { width: `${percent}%` }
        }
      ) }),
      /* @__PURE__ */ jsxs3("p", { className: "sk-timeline__rollup", children: [
        derived?.done ?? 0,
        " / ",
        derived?.total ?? roster.length,
        " phases (",
        percent,
        "%)"
      ] }),
      /* @__PURE__ */ jsx4("ol", { className: "sk-timeline__steps", children: roster.map((step) => /* @__PURE__ */ jsxs3(
        "li",
        {
          className: clsx3("sk-timeline__step", `sk-timeline__step--${step.status}`),
          children: [
            /* @__PURE__ */ jsx4("span", { className: "sk-timeline__step-num", children: step.number }),
            /* @__PURE__ */ jsx4("span", { className: "sk-timeline__step-title", children: step.title }),
            /* @__PURE__ */ jsx4(Status, { value: step.status })
          ]
        },
        step.slug
      )) }),
      children
    ] });
  }
  return /* @__PURE__ */ jsxs3("figure", { className: "sk-timeline", children: [
    caption ? /* @__PURE__ */ jsx4("figcaption", { className: "sk-timeline__caption", children: caption }) : null,
    /* @__PURE__ */ jsx4("ol", { className: "sk-timeline__list", children: milestones.map((m, i) => /* @__PURE__ */ jsxs3(
      "li",
      {
        className: clsx3("sk-timeline__item", m.status && `sk-timeline__item--${m.status}`),
        children: [
          /* @__PURE__ */ jsx4("span", { className: "sk-timeline__marker", "aria-hidden": true }),
          /* @__PURE__ */ jsxs3("div", { className: "sk-timeline__content", children: [
            /* @__PURE__ */ jsxs3("div", { className: "sk-timeline__head", children: [
              /* @__PURE__ */ jsx4("strong", { className: "sk-timeline__label", children: m.label }),
              m.when ? /* @__PURE__ */ jsx4("span", { className: "sk-timeline__when", children: m.when }) : null
            ] }),
            m.description ? /* @__PURE__ */ jsx4("p", { className: "sk-timeline__description", children: m.description }) : null
          ] })
        ]
      },
      `${m.label}-${i}`
    )) }),
    children
  ] });
}

// src/components/SubSpec.tsx
import { jsx as jsx5, jsxs as jsxs4 } from "react/jsx-runtime";
function SubSpec({ slug, title, status, summary, children }) {
  return /* @__PURE__ */ jsxs4("article", { className: "sk-subspec", "data-slug": slug, children: [
    /* @__PURE__ */ jsxs4("header", { className: "sk-subspec__header", children: [
      /* @__PURE__ */ jsxs4("a", { className: "sk-subspec__link", href: `#${slug}`, children: [
        /* @__PURE__ */ jsx5("span", { className: "sk-subspec__slug", children: slug }),
        /* @__PURE__ */ jsx5("span", { className: "sk-subspec__title", children: title })
      ] }),
      status ? /* @__PURE__ */ jsx5(Status, { value: status }) : null
    ] }),
    summary ? /* @__PURE__ */ jsx5("p", { className: "sk-subspec__summary", children: summary }) : null,
    children
  ] });
}

// src/components/icons.tsx
import { jsx as jsx6, jsxs as jsxs5 } from "react/jsx-runtime";
function Icon({ size = 14, children, ...rest }) {
  return /* @__PURE__ */ jsx6(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.75,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
      ...rest,
      children
    }
  );
}
function ArrowUpRightIcon(props) {
  return /* @__PURE__ */ jsxs5(Icon, { ...props, children: [
    /* @__PURE__ */ jsx6("path", { d: "M7 7h10v10" }),
    /* @__PURE__ */ jsx6("path", { d: "M7 17 17 7" })
  ] });
}
function CircleHelpIcon(props) {
  return /* @__PURE__ */ jsxs5(Icon, { ...props, children: [
    /* @__PURE__ */ jsx6("circle", { cx: "12", cy: "12", r: "10" }),
    /* @__PURE__ */ jsx6("path", { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" }),
    /* @__PURE__ */ jsx6("path", { d: "M12 17h.01" })
  ] });
}
function UserIcon(props) {
  return /* @__PURE__ */ jsxs5(Icon, { ...props, children: [
    /* @__PURE__ */ jsx6("path", { d: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" }),
    /* @__PURE__ */ jsx6("circle", { cx: "12", cy: "7", r: "4" })
  ] });
}

// src/components/CrossRef.tsx
import { jsx as jsx7, jsxs as jsxs6 } from "react/jsx-runtime";
function targetToHref(to) {
  const [slug, anchor] = to.split("#");
  const safeSlug = slug?.trim() ?? "";
  const safeAnchor = anchor?.trim();
  if (safeAnchor) return `#${safeSlug}--${safeAnchor}`;
  return `#${safeSlug}`;
}
function CrossRef({ to, label, children }) {
  const text = children ?? label ?? to;
  return /* @__PURE__ */ jsxs6("a", { className: "sk-crossref", href: targetToHref(to), "data-crossref": to, children: [
    /* @__PURE__ */ jsx7("span", { className: "sk-crossref__icon", "aria-hidden": true, children: /* @__PURE__ */ jsx7(ArrowUpRightIcon, { size: 12 }) }),
    /* @__PURE__ */ jsx7("span", { className: "sk-crossref__label", children: text })
  ] });
}

// src/components/AgentAllocation.tsx
import clsx4 from "clsx";
import { jsx as jsx8, jsxs as jsxs7 } from "react/jsx-runtime";
var typeLabel = {
  "sub-agent": "Sub-agent",
  "agent-team": "Agent team",
  human: "Human"
};
function AgentAllocation({ context, entries, children }) {
  return /* @__PURE__ */ jsxs7("div", { className: "sk-allocation", children: [
    context ? /* @__PURE__ */ jsx8("p", { className: "sk-allocation__context", children: context }) : null,
    /* @__PURE__ */ jsxs7("table", { className: "sk-allocation__table", children: [
      /* @__PURE__ */ jsx8("thead", { children: /* @__PURE__ */ jsxs7("tr", { children: [
        /* @__PURE__ */ jsx8("th", { children: "Agent" }),
        /* @__PURE__ */ jsx8("th", { children: "Type" }),
        /* @__PURE__ */ jsx8("th", { children: "Responsibility" }),
        /* @__PURE__ */ jsx8("th", { children: "Phases" })
      ] }) }),
      /* @__PURE__ */ jsx8("tbody", { children: entries.map((e, i) => /* @__PURE__ */ jsxs7("tr", { children: [
        /* @__PURE__ */ jsx8("td", { children: /* @__PURE__ */ jsx8("strong", { children: e.name }) }),
        /* @__PURE__ */ jsx8("td", { children: /* @__PURE__ */ jsx8("span", { className: clsx4("sk-allocation__type", `sk-allocation__type--${e.type}`), children: typeLabel[e.type] }) }),
        /* @__PURE__ */ jsx8("td", { children: e.responsibility }),
        /* @__PURE__ */ jsx8("td", { children: e.phases?.length ? e.phases.join(", ") : "\u2014" })
      ] }, `${e.name}-${i}`)) })
    ] }),
    children
  ] });
}

// src/components/AgentTree.tsx
import clsx5 from "clsx";
import { createContext as createContext2, useContext as useContext2 } from "react";

// src/agent-tree.ts
function flattenAgentTree(nodes) {
  const out = [];
  const walk = (list, depth, parentName, inheritedEffort) => {
    for (const node of list) {
      const resolvedEffort = node.effort ?? inheritedEffort;
      out.push({
        node,
        depth,
        parentName,
        resolvedEffort,
        resolvedModel: node.model ?? null
      });
      if (node.subAgents?.length) {
        walk(node.subAgents, depth + 1, node.name, resolvedEffort);
      }
    }
  };
  walk(nodes, 0, null, null);
  return out;
}
function resolveNodeEffort(name, nodes) {
  const hit = flattenAgentTree(nodes).find((f) => f.node.name === name);
  return hit ? hit.resolvedEffort : null;
}
function collectAgentNames(nodes) {
  return flattenAgentTree(nodes).map((f) => f.node.name);
}

// src/components/AgentTree.tsx
import { jsx as jsx9, jsxs as jsxs8 } from "react/jsx-runtime";
var MODELS = ["opus", "sonnet", "haiku"];
var EFFORTS = ["low", "medium", "high", "max"];
var typeLabel2 = {
  orchestrator: "Orchestrator",
  "sub-agent": "Sub-agent",
  "agent-team": "Team"
};
var AgentTreeControlsContext = createContext2(null);
function AgentTree({
  nodes,
  context,
  editable = false,
  dirty = false,
  onEffortChange,
  onModelChange,
  children
}) {
  const controlsFactory = useContext2(AgentTreeControlsContext);
  const controls = controlsFactory ? controlsFactory(nodes) : null;
  const isEditable = controls ? true : editable;
  const isDirty = controls ? controls.dirty : dirty;
  const renderNodes = controls ? controls.nodes : nodes;
  const handleModel = controls ? controls.onModelChange : onModelChange;
  const handleEffort = controls ? controls.onEffortChange : onEffortChange;
  const flat = flattenAgentTree(renderNodes);
  return /* @__PURE__ */ jsxs8("div", { className: clsx5("sk-agent-tree", isDirty && "sk-agent-tree--dirty"), children: [
    context ? /* @__PURE__ */ jsx9("p", { className: "sk-agent-tree__context", children: context }) : null,
    isDirty ? /* @__PURE__ */ jsx9("span", { className: "sk-agent-tree__pending", "aria-label": "unsaved changes" }) : null,
    /* @__PURE__ */ jsx9("ul", { className: "sk-agent-tree__list", children: flat.map(({ node, depth, resolvedEffort, resolvedModel }) => {
      const label = node.type === "agent-team" ? node.teamName ?? node.name : node.name;
      const ownEffort = node.effort;
      return /* @__PURE__ */ jsxs8(
        "li",
        {
          "data-agent-name": node.name,
          className: "sk-agent-tree__row",
          style: { paddingLeft: `${0.75 + depth * 1.25}rem` },
          children: [
            /* @__PURE__ */ jsx9("span", { className: "sk-agent-tree__name", children: label }),
            node.type === "agent-team" && node.teamName ? /* @__PURE__ */ jsx9("span", { className: "sk-agent-tree__agentname", children: node.name }) : null,
            /* @__PURE__ */ jsx9("span", { className: clsx5("sk-agent-tree__type", `sk-agent-tree__type--${node.type}`), children: typeLabel2[node.type] }),
            isEditable ? /* @__PURE__ */ jsxs8(
              "select",
              {
                "data-field": "model",
                className: "sk-agent-tree__select",
                value: resolvedModel ?? "",
                onChange: (e) => handleModel?.(node.name, e.target.value),
                children: [
                  /* @__PURE__ */ jsx9("option", { value: "", disabled: true, children: "model\u2026" }),
                  MODELS.map((m) => /* @__PURE__ */ jsx9("option", { value: m, children: m }, m))
                ]
              }
            ) : /* @__PURE__ */ jsx9("span", { className: "sk-agent-tree__model", children: resolvedModel ?? "\u2014" }),
            node.count !== void 0 && node.count > 1 ? /* @__PURE__ */ jsxs8("span", { className: "sk-agent-tree__count", children: [
              "\xD7",
              node.count
            ] }) : null,
            isEditable ? /* @__PURE__ */ jsxs8(
              "select",
              {
                "data-field": "effort",
                "data-inherited": ownEffort === void 0 ? "true" : "false",
                className: "sk-agent-tree__select",
                value: ownEffort ?? "",
                onChange: (e) => handleEffort?.(
                  node.name,
                  e.target.value === "" ? null : e.target.value
                ),
                children: [
                  /* @__PURE__ */ jsxs8("option", { value: "", children: [
                    "inherit",
                    resolvedEffort ? ` (${resolvedEffort})` : ""
                  ] }),
                  EFFORTS.map((ef) => /* @__PURE__ */ jsx9("option", { value: ef, children: ef }, ef))
                ]
              }
            ) : /* @__PURE__ */ jsx9(
              "span",
              {
                className: "sk-agent-tree__effort",
                "data-inherited": ownEffort === void 0 ? "true" : "false",
                children: resolvedEffort ?? "\u2014"
              }
            )
          ]
        },
        node.name
      );
    }) }),
    controls && isDirty ? /* @__PURE__ */ jsxs8("div", { className: "sk-agent-tree-view__actions", children: [
      /* @__PURE__ */ jsx9("button", { type: "button", onClick: controls.onSave, children: "Save" }),
      /* @__PURE__ */ jsx9("button", { type: "button", onClick: controls.onDiscard, children: "Discard" })
    ] }) : null,
    children
  ] });
}

// src/components/Team.tsx
import { jsx as jsx10, jsxs as jsxs9 } from "react/jsx-runtime";
function Team({ name, members, mission, children }) {
  return /* @__PURE__ */ jsxs9("section", { className: "sk-team", children: [
    /* @__PURE__ */ jsxs9("header", { className: "sk-team__header", children: [
      /* @__PURE__ */ jsx10("h4", { className: "sk-team__name", children: name }),
      mission ? /* @__PURE__ */ jsx10("p", { className: "sk-team__mission", children: mission }) : null
    ] }),
    /* @__PURE__ */ jsx10("ul", { className: "sk-team__members", children: members.map((m, i) => /* @__PURE__ */ jsxs9("li", { className: "sk-team__member", children: [
      /* @__PURE__ */ jsx10("span", { className: "sk-team__member-name", children: m.name }),
      /* @__PURE__ */ jsx10("span", { className: "sk-team__member-role", children: m.role }),
      m.handle ? /* @__PURE__ */ jsxs9("span", { className: "sk-team__member-handle", children: [
        "@",
        m.handle
      ] }) : null
    ] }, `${m.name}-${i}`)) }),
    children
  ] });
}

// src/components/Reviewer.tsx
import { jsx as jsx11, jsxs as jsxs10 } from "react/jsx-runtime";
function Reviewer({ name, role, scope, handle, children }) {
  return /* @__PURE__ */ jsxs10("div", { className: "sk-reviewer", children: [
    /* @__PURE__ */ jsx11("span", { className: "sk-reviewer__icon", "aria-hidden": true, children: /* @__PURE__ */ jsx11(UserIcon, { size: 18 }) }),
    /* @__PURE__ */ jsxs10("div", { className: "sk-reviewer__body", children: [
      /* @__PURE__ */ jsxs10("div", { className: "sk-reviewer__head", children: [
        /* @__PURE__ */ jsx11("strong", { className: "sk-reviewer__name", children: name }),
        /* @__PURE__ */ jsx11("span", { className: "sk-reviewer__role", children: role }),
        handle ? /* @__PURE__ */ jsxs10("span", { className: "sk-reviewer__handle", children: [
          "@",
          handle
        ] }) : null
      ] }),
      /* @__PURE__ */ jsxs10("div", { className: "sk-reviewer__scope", children: [
        "Reviews: ",
        scope
      ] }),
      children
    ] })
  ] });
}

// src/components/OpenQuestion.tsx
import { jsx as jsx12, jsxs as jsxs11 } from "react/jsx-runtime";
function OpenQuestion({ id, question, owner, resolveBy, children }) {
  return /* @__PURE__ */ jsxs11("aside", { className: "sk-question", "data-question-id": id ?? "", children: [
    /* @__PURE__ */ jsxs11("header", { className: "sk-question__header", children: [
      /* @__PURE__ */ jsx12("span", { className: "sk-question__icon", "aria-hidden": true, children: /* @__PURE__ */ jsx12(CircleHelpIcon, { size: 16 }) }),
      id ? /* @__PURE__ */ jsx12("span", { className: "sk-question__id", children: id }) : null,
      /* @__PURE__ */ jsx12("span", { className: "sk-question__text", children: question })
    ] }),
    /* @__PURE__ */ jsxs11("div", { className: "sk-question__meta", children: [
      owner ? /* @__PURE__ */ jsxs11("span", { className: "sk-question__owner", children: [
        "Owner: ",
        owner
      ] }) : null,
      resolveBy ? /* @__PURE__ */ jsxs11("span", { className: "sk-question__by", children: [
        "Needed by: ",
        resolveBy
      ] }) : null
    ] }),
    children ? /* @__PURE__ */ jsx12("div", { className: "sk-question__body", children }) : null
  ] });
}

// src/components/Risk.tsx
import clsx6 from "clsx";
import { jsx as jsx13, jsxs as jsxs12 } from "react/jsx-runtime";
function Risk({ id, title, severity, category, mitigation, children }) {
  return /* @__PURE__ */ jsxs12("aside", { className: clsx6("sk-risk", `sk-risk--${severity}`), "data-risk-id": id ?? "", children: [
    /* @__PURE__ */ jsxs12("header", { className: "sk-risk__header", children: [
      /* @__PURE__ */ jsx13("span", { className: clsx6("sk-risk__badge", `sk-risk__badge--${severity}`), children: severity.toUpperCase() }),
      id ? /* @__PURE__ */ jsx13("span", { className: "sk-risk__id", children: id }) : null,
      /* @__PURE__ */ jsx13("span", { className: "sk-risk__title", children: title }),
      category ? /* @__PURE__ */ jsx13("span", { className: "sk-risk__category", children: category }) : null
    ] }),
    mitigation ? /* @__PURE__ */ jsxs12("div", { className: "sk-risk__mitigation", children: [
      /* @__PURE__ */ jsx13("strong", { children: "Mitigation:" }),
      " ",
      mitigation
    ] }) : null,
    children ? /* @__PURE__ */ jsx13("div", { className: "sk-risk__body", children }) : null
  ] });
}

// src/components/Mockup.tsx
import { jsx as jsx14, jsxs as jsxs13 } from "react/jsx-runtime";
function Mockup({ src, alt, caption, maxWidth, children }) {
  return /* @__PURE__ */ jsxs13("figure", { className: "sk-mockup", children: [
    /* @__PURE__ */ jsx14(
      "img",
      {
        className: "sk-mockup__image",
        src,
        alt,
        style: maxWidth ? { maxWidth } : void 0
      }
    ),
    caption ? /* @__PURE__ */ jsx14("figcaption", { className: "sk-mockup__caption", children: caption }) : null,
    children
  ] });
}

// src/components/Chart.tsx
import { useEffect as useEffect2, useRef as useRef2, useState as useState2 } from "react";
import { jsx as jsx15, jsxs as jsxs14 } from "react/jsx-runtime";
var mermaidPromise = null;
function loadMermaid() {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import("mermaid").then((m) => {
    const api = m.default ?? m;
    api.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
    return api;
  });
  return mermaidPromise;
}
var renderCache = /* @__PURE__ */ new Map();
function hashSource(src) {
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = h * 33 ^ src.charCodeAt(i);
  return (h >>> 0).toString(36);
}
function renderToSvg(source) {
  let cached = renderCache.get(source);
  if (!cached) {
    const renderId = `sk-chart-${hashSource(source)}`;
    cached = loadMermaid().then((mermaid) => mermaid.render(renderId, source)).then(({ svg }) => svg);
    cached.catch(() => renderCache.delete(source));
    renderCache.set(source, cached);
  }
  return cached;
}
function extractSource(props) {
  if (props.source) return props.source;
  if (typeof props.children === "string") return props.children;
  if (Array.isArray(props.children)) {
    return props.children.filter((c) => typeof c === "string").join("");
  }
  return "";
}
function attachSvg(container, svgString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, "text/html");
  const svg = doc.body.querySelector("svg");
  if (!svg) throw new Error("Mermaid produced output without an <svg> element");
  for (const script of Array.from(svg.querySelectorAll("script"))) {
    script.remove();
  }
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(svg);
}
function Chart(props) {
  const { kind, caption } = props;
  const figureRef = useRef2(null);
  const ref = useRef2(null);
  const [error, setError] = useState2(null);
  const [visible, setVisible] = useState2(false);
  const source = extractSource(props).trim();
  useEffect2(() => {
    const el = figureRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect2(() => {
    if (!source || !visible) return;
    let cancelled = false;
    renderToSvg(source).then((svg) => {
      if (cancelled || !ref.current) return;
      attachSvg(ref.current, svg);
      setError(null);
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [source, visible]);
  return /* @__PURE__ */ jsxs14("figure", { ref: figureRef, className: "sk-chart", "data-kind": kind ?? "flow", children: [
    /* @__PURE__ */ jsx15("div", { ref, className: "sk-chart__svg" }),
    error ? /* @__PURE__ */ jsxs14("pre", { className: "sk-chart__error", children: [
      error,
      "\n\n",
      source
    ] }) : !source ? /* @__PURE__ */ jsx15("pre", { className: "sk-chart__error", children: "Chart: missing source" }) : null,
    caption ? /* @__PURE__ */ jsx15("figcaption", { className: "sk-chart__caption", children: caption }) : null
  ] });
}

export {
  Status,
  useExecutionState,
  ExecutionStateProvider,
  Phase,
  Timeline,
  SubSpec,
  CrossRef,
  AgentAllocation,
  flattenAgentTree,
  resolveNodeEffort,
  collectAgentNames,
  AgentTreeControlsContext,
  AgentTree,
  Team,
  Reviewer,
  OpenQuestion,
  Risk,
  Mockup,
  Chart
};
//# sourceMappingURL=chunk-QCO7ZFR5.js.map