// schemas/Status.schema.json
var Status_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $ref: "#/definitions/StatusProps",
  definitions: {
    StatusProps: {
      type: "object",
      properties: {
        value: {
          $ref: "#/definitions/StatusValue"
        },
        note: {
          type: "string"
        },
        editable: {
          type: "boolean"
        },
        dirty: {
          type: "boolean"
        },
        onChange: {
          $comment: "(next: StatusValue) => void",
          type: "object",
          properties: {
            namedArgs: {
              type: "object",
              properties: {
                next: {
                  $ref: "#/definitions/StatusValue"
                }
              },
              required: [
                "next"
              ],
              additionalProperties: false
            }
          }
        }
      },
      required: [
        "value"
      ],
      additionalProperties: false
    },
    StatusValue: {
      type: "string",
      enum: [
        "draft",
        "proposed",
        "in-progress",
        "blocked",
        "done",
        "shipped"
      ]
    }
  }
};

// schemas/Phase.schema.json
var Phase_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $ref: "#/definitions/PhaseProps",
  definitions: {
    PhaseProps: {
      type: "object",
      properties: {
        number: {
          type: "number"
        },
        title: {
          type: "string"
        },
        id: {
          type: "string",
          description: 'Stable slug used to key execution state, e.g. "storage".'
        },
        status: {
          $ref: "#/definitions/StatusValue",
          description: "Authored status badge; overridden by live execution state when present."
        },
        summary: {
          type: "string"
        },
        estimate: {
          type: "string"
        },
        editable: {
          type: "boolean"
        },
        statusDirty: {
          type: "boolean"
        },
        onStatusChange: {
          $comment: "(next: StatusValue) => void",
          type: "object",
          properties: {
            namedArgs: {
              type: "object",
              properties: {
                next: {
                  $ref: "#/definitions/StatusValue"
                }
              },
              required: [
                "next"
              ],
              additionalProperties: false
            }
          }
        }
      },
      required: [
        "number",
        "title"
      ],
      additionalProperties: false
    },
    StatusValue: {
      type: "string",
      enum: [
        "draft",
        "proposed",
        "in-progress",
        "blocked",
        "done",
        "shipped"
      ]
    }
  }
};

// schemas/Timeline.schema.json
var Timeline_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $ref: "#/definitions/TimelineProps",
  definitions: {
    TimelineProps: {
      type: "object",
      properties: {
        milestones: {
          type: "array",
          items: {
            $ref: "#/definitions/TimelineMilestone"
          },
          description: "Legacy static milestones. Omit for the phase-driven live form."
        },
        caption: {
          type: "string",
          description: "Optional caption above the timeline."
        }
      },
      additionalProperties: false
    },
    TimelineMilestone: {
      type: "object",
      properties: {
        label: {
          type: "string"
        },
        when: {
          type: "string",
          description: "ISO date or human string."
        },
        status: {
          $ref: "#/definitions/StatusValue"
        },
        description: {
          type: "string"
        }
      },
      required: [
        "label"
      ],
      additionalProperties: false
    },
    StatusValue: {
      type: "string",
      enum: [
        "draft",
        "proposed",
        "in-progress",
        "blocked",
        "done",
        "shipped"
      ]
    }
  }
};

// schemas/SubSpec.schema.json
var SubSpec_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $ref: "#/definitions/SubSpecProps",
  definitions: {
    SubSpecProps: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: 'Sibling spec slug, e.g. "01-architecture".'
        },
        title: {
          type: "string"
        },
        status: {
          $ref: "#/definitions/StatusValue"
        },
        summary: {
          type: "string",
          description: "Short one-line summary."
        }
      },
      required: [
        "slug",
        "title"
      ],
      additionalProperties: false
    },
    StatusValue: {
      type: "string",
      enum: [
        "draft",
        "proposed",
        "in-progress",
        "blocked",
        "done",
        "shipped"
      ]
    }
  }
};

// schemas/CrossRef.schema.json
var CrossRef_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $ref: "#/definitions/CrossRefProps",
  definitions: {
    CrossRefProps: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Target reference. Format: `<slug>` or `<slug>#<anchor>`. Slug is another spec file in the same session (without extension). Anchor is a slugified heading inside that file."
        },
        label: {
          type: "string",
          description: "Optional human label override. Defaults to children, then `to`."
        }
      },
      required: [
        "to"
      ],
      additionalProperties: false
    }
  }
};

// schemas/AgentAllocation.schema.json
var AgentAllocation_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $ref: "#/definitions/AgentAllocationProps",
  definitions: {
    AgentAllocationProps: {
      type: "object",
      properties: {
        context: {
          type: "string"
        },
        entries: {
          type: "array",
          items: {
            $ref: "#/definitions/AgentAllocationEntry"
          }
        }
      },
      required: [
        "entries"
      ],
      additionalProperties: false
    },
    AgentAllocationEntry: {
      type: "object",
      properties: {
        name: {
          type: "string"
        },
        type: {
          $ref: "#/definitions/AgentType"
        },
        responsibility: {
          type: "string"
        },
        phases: {
          type: "array",
          items: {
            type: [
              "number",
              "string"
            ]
          },
          description: "Phases this agent touches \u2014 slugs (preferred) or legacy numbers."
        }
      },
      required: [
        "name",
        "type",
        "responsibility"
      ],
      additionalProperties: false
    },
    AgentType: {
      type: "string",
      enum: [
        "sub-agent",
        "agent-team",
        "human"
      ]
    }
  }
};

// schemas/Team.schema.json
var Team_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $ref: "#/definitions/TeamProps",
  definitions: {
    TeamProps: {
      type: "object",
      properties: {
        name: {
          type: "string"
        },
        members: {
          type: "array",
          items: {
            $ref: "#/definitions/TeamMember"
          }
        },
        mission: {
          type: "string",
          description: "What this team is responsible for."
        }
      },
      required: [
        "name",
        "members"
      ],
      additionalProperties: false
    },
    TeamMember: {
      type: "object",
      properties: {
        name: {
          type: "string"
        },
        role: {
          $ref: "#/definitions/ActorRole"
        },
        handle: {
          type: "string",
          description: "Optional handle, e.g. github username."
        }
      },
      required: [
        "name",
        "role"
      ],
      additionalProperties: false
    },
    ActorRole: {
      type: "string",
      enum: [
        "designer",
        "engineer",
        "pm",
        "reviewer",
        "qa",
        "sre",
        "lead"
      ]
    }
  }
};

// schemas/Reviewer.schema.json
var Reviewer_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $ref: "#/definitions/ReviewerProps",
  definitions: {
    ReviewerProps: {
      type: "object",
      properties: {
        name: {
          type: "string"
        },
        role: {
          $ref: "#/definitions/ActorRole"
        },
        scope: {
          type: "string",
          description: "Which areas they sign off on."
        },
        handle: {
          type: "string"
        }
      },
      required: [
        "name",
        "role",
        "scope"
      ],
      additionalProperties: false
    },
    ActorRole: {
      type: "string",
      enum: [
        "designer",
        "engineer",
        "pm",
        "reviewer",
        "qa",
        "sre",
        "lead"
      ]
    }
  }
};

// schemas/OpenQuestion.schema.json
var OpenQuestion_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $ref: "#/definitions/OpenQuestionProps",
  definitions: {
    OpenQuestionProps: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: 'Short identifier, e.g. "Q1". Used for cross-refs.'
        },
        question: {
          type: "string"
        },
        owner: {
          type: "string",
          description: "Who needs to answer."
        },
        resolveBy: {
          type: "string",
          description: "When this needs to be resolved."
        }
      },
      required: [
        "question"
      ],
      additionalProperties: false
    }
  }
};

// schemas/Risk.schema.json
var Risk_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $ref: "#/definitions/RiskProps",
  definitions: {
    RiskProps: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: 'Short identifier, e.g. "R1".'
        },
        title: {
          type: "string"
        },
        severity: {
          $ref: "#/definitions/Severity"
        },
        category: {
          $ref: "#/definitions/RiskCategory"
        },
        mitigation: {
          type: "string",
          description: "What mitigates this."
        }
      },
      required: [
        "title",
        "severity"
      ],
      additionalProperties: false
    },
    Severity: {
      type: "string",
      enum: [
        "low",
        "medium",
        "high",
        "critical"
      ]
    },
    RiskCategory: {
      type: "string",
      enum: [
        "technical",
        "product",
        "security",
        "performance",
        "process",
        "scope"
      ]
    }
  }
};

// schemas/Mockup.schema.json
var Mockup_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $ref: "#/definitions/MockupProps",
  definitions: {
    MockupProps: {
      type: "object",
      properties: {
        src: {
          type: "string",
          description: "Path to image relative to the session's `assets/` folder, or absolute URL."
        },
        alt: {
          type: "string"
        },
        caption: {
          type: "string"
        },
        maxWidth: {
          type: "string",
          description: "Optional max width in px or CSS unit."
        }
      },
      required: [
        "src",
        "alt"
      ],
      additionalProperties: false
    }
  }
};

// schemas/Chart.schema.json
var Chart_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $ref: "#/definitions/ChartProps",
  definitions: {
    ChartProps: {
      type: "object",
      properties: {
        kind: {
          $ref: "#/definitions/ChartKind",
          description: "Diagram type. Drives the Mermaid prelude. If the source already begins with a Mermaid directive (e.g. `graph TD`, `sequenceDiagram`), `kind` is informational only."
        },
        source: {
          type: "string",
          description: "Mermaid source. Prefer placing it as children for multi-line diagrams."
        },
        caption: {
          type: "string",
          description: "Optional caption shown under the chart."
        }
      },
      additionalProperties: false
    },
    ChartKind: {
      type: "string",
      enum: [
        "flow",
        "sequence",
        "state",
        "class",
        "er",
        "gantt",
        "mindmap",
        "architecture"
      ]
    }
  }
};

// schemas/AgentTree.schema.json
var AgentTree_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $ref: "#/definitions/AgentTreeProps",
  definitions: {
    AgentTreeProps: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          items: {
            $ref: "#/definitions/AgentTreeNode"
          }
        },
        context: {
          type: "string"
        }
      },
      required: [
        "nodes"
      ],
      additionalProperties: false
    },
    AgentTreeNode: {
      type: "object",
      properties: {
        name: {
          type: "string"
        },
        type: {
          type: "string",
          enum: [
            "orchestrator",
            "sub-agent",
            "agent-team"
          ]
        },
        teamName: {
          type: "string",
          description: "Display name for team nodes."
        },
        responsibility: {
          type: "string"
        },
        model: {
          $ref: "#/definitions/AgentModel",
          description: "Per-node model. Does NOT inherit."
        },
        effort: {
          $ref: "#/definitions/AgentEffort",
          description: "Effort; inherited from the nearest ancestor when absent."
        },
        count: {
          type: "number"
        },
        subAgents: {
          type: "array",
          items: {
            $ref: "#/definitions/AgentTreeNode"
          },
          description: "Child nodes. Recurses for tree traversal."
        }
      },
      required: [
        "name",
        "type"
      ],
      additionalProperties: false
    },
    AgentModel: {
      type: "string",
      enum: [
        "opus",
        "sonnet",
        "haiku"
      ]
    },
    AgentEffort: {
      type: "string",
      enum: [
        "low",
        "medium",
        "high",
        "max"
      ]
    }
  }
};

// src/schemas-index.ts
var schemas = {
  Status: Status_schema_default,
  Phase: Phase_schema_default,
  Timeline: Timeline_schema_default,
  SubSpec: SubSpec_schema_default,
  CrossRef: CrossRef_schema_default,
  AgentAllocation: AgentAllocation_schema_default,
  Team: Team_schema_default,
  Reviewer: Reviewer_schema_default,
  OpenQuestion: OpenQuestion_schema_default,
  Risk: Risk_schema_default,
  Mockup: Mockup_schema_default,
  Chart: Chart_schema_default,
  AgentTree: AgentTree_schema_default
};
var componentNames = [
  "Status",
  "Phase",
  "Timeline",
  "SubSpec",
  "CrossRef",
  "AgentAllocation",
  "Team",
  "Reviewer",
  "OpenQuestion",
  "Risk",
  "Mockup",
  "Chart",
  "AgentTree"
];

export {
  schemas,
  componentNames
};
//# sourceMappingURL=chunk-5JBLA3W7.js.map