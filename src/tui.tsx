import React, { useEffect, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import fs from "node:fs";
import path from "node:path";
import { stateRoot } from "./paths.js";
import { loadMeta, Meta } from "./worktree.js";
import { readLog, LogEntry } from "./log.js";

const POLL_MS = 1000;

function listFeatures(repoRoot: string): string[] {
  const root = stateRoot(repoRoot);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => fs.existsSync(path.join(root, name, "meta.json")))
    .sort();
}

export function stepColor(step: string): string {
  if (step === "final_done" || step === "tester_done") return "green";
  if (step === "needs_po_attention") return "red";
  if (step === "iteration") return "yellow";
  return "cyan";
}

export function actorBadge(actor: LogEntry["actor"]): string {
  switch (actor) {
    case "pm":
      return "PM";
    case "dev":
      return "DEV";
    case "tester":
      return "TESTER";
    default:
      return "SYS";
  }
}

interface FeatureState {
  feature: string;
  meta: Meta | null;
  log: LogEntry[];
}

function loadAll(repoRoot: string): FeatureState[] {
  return listFeatures(repoRoot).map((feature) => {
    try {
      return { feature, meta: loadMeta(repoRoot, feature), log: readLog(repoRoot, feature) };
    } catch {
      return { feature, meta: null, log: [] };
    }
  });
}

function App({ repoRoot }: { repoRoot: string }) {
  const { exit } = useApp();
  const [features, setFeatures] = useState<FeatureState[]>(() => loadAll(repoRoot));
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setFeatures(loadAll(repoRoot)), POLL_MS);
    return () => clearInterval(timer);
  }, [repoRoot]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) setSelected((i) => Math.min(features.length - 1, i + 1));
  });

  const current = features[selected];

  return (
    <Box flexDirection="column" width={100}>
      <Box>
        <Text bold>pmctl watch</Text>
        <Text dimColor> — ↑/↓ เลือก feature, q ออก</Text>
      </Box>
      <Box marginTop={1}>
        <Box flexDirection="column" width={26} borderStyle="single" paddingX={1}>
          <Text bold dimColor>
            FEATURES
          </Text>
          {features.length === 0 && <Text dimColor>(ยังไม่มี)</Text>}
          {features.map((f, i) => {
            const last = f.log[f.log.length - 1];
            const color = last ? stepColor(last.step) : "white";
            return (
              <Text key={f.feature} color={i === selected ? "black" : color} backgroundColor={i === selected ? color : undefined}>
                {i === selected ? "› " : "  "}
                {f.feature}
              </Text>
            );
          })}
        </Box>

        <Box flexDirection="column" width={72} borderStyle="single" paddingX={1} marginLeft={1}>
          {!current && <Text dimColor>เลือก feature ทางซ้ายเพื่อดูรายละเอียด</Text>}
          {current && (
            <>
              <Text bold>{current.feature}</Text>
              {current.meta && (
                <Text dimColor>
                  branch={current.meta.branch} port={current.meta.port}
                </Text>
              )}
              <Box marginTop={1} flexDirection="column">
                {current.log.length === 0 && <Text dimColor>(ยังไม่มี log)</Text>}
                {current.log.slice(-12).map((entry, i) => (
                  <Text key={i}>
                    <Text color={stepColor(entry.step)}>
                      [{actorBadge(entry.actor)}] {entry.step}
                    </Text>
                    <Text dimColor> — {entry.reason}</Text>
                  </Text>
                ))}
              </Box>
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
}

export function runTui(repoRoot: string): void {
  render(<App repoRoot={repoRoot} />);
}
