// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TermHelp — a "What's this?" beside a term the app uses (a trust tier, the Shack, an attested site): it opens
 * the manual's glossary at that term, so the words in the app and in the manual are one vocabulary. Outside
 * the platform (the demo harness) it is a plain link to the same page.
 */
import { useContext, type ReactNode } from "react";
import { Button } from "../ui/index.js";
import { PlatformContext } from "./PlatformContext.js";

export function TermHelp(props: { term: string; doc?: string; children?: ReactNode }) {
  const doc = props.doc ?? "glossary";
  const open = useContext(PlatformContext)?.openDocs;
  const label = props.children ?? "What's this?";
  if (!open) return <a href={`/?view=docs&doc=${doc}#${props.term}`}>{label}</a>;
  return (
    <Button variant="quiet" className="term-help" onClick={() => open(doc, props.term)}>
      {label}
    </Button>
  );
}
