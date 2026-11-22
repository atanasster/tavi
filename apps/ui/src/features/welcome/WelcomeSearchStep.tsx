import { useRef, useState, type FormEvent } from "react";

import { WEB_SEARCH_KINDS, type WebSearchKind } from "@tavi/contracts";

import { useT } from "../../lib/i18n.js";
import { addSearchProvider } from "./onboarding-api.js";
import { type StepProps, Working } from "./WelcomeStepParts.js";
import { Failure } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { Field } from "../../ui/Field.js";
import { Select } from "../../ui/Select.js";
import { SEARCH_KIND_LABELS, keyToStore, searchKindNeeds } from "../settings/search-api.js";
import { WebSearchProviderFields } from "../settings/WebSearchProviderFields.js";

export function SearchStep(props: StepProps) {
  const t = useT();
  // Tavily first: it starts without a key, so the step works before you have one.
  const [kind, setKind] = useState<WebSearchKind>("tavily");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [keyError, setKeyError] = useState<string>();
  // What this step added, so a retry tests it again rather than adding a second.
  const madeHere = useRef<Record<string, { added: boolean; keyed?: boolean; keyStored?: boolean }>>({});
  // None for SearXNG, whatever the hidden field still holds; an empty one is not sent.
  const stored = keyToStore({ kind, apiKey: key });
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (searchKindNeeds(kind).key === "required" && stored === "")
      return setKeyError(t("welcome.search.needsKey", { provider: SEARCH_KIND_LABELS[kind] }));
    setWorking(true);
    setProblem(undefined);
    const added = await addSearchProvider(
      props.client,
      kind,
      stored === "" ? undefined : stored,
      searchKindNeeds(kind).baseUrl ? baseUrl.trim() : undefined,
      (madeHere.current[kind] ??= { added: false }),
    );
    setWorking(false);
    if (!added.ok) return setProblem(added.message);
    props.onDone();
  };
  return (
    <form className="welcome-search" onSubmit={(event) => void submit(event)}>
      <Field label={t("welcome.search.provider")}>
        <Select
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as WebSearchKind);
            setKeyError(undefined);
          }}
        >
          {WEB_SEARCH_KINDS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {SEARCH_KIND_LABELS[candidate]}
            </option>
          ))}
        </Select>
      </Field>
      <WebSearchProviderFields
        kind={kind}
        baseUrl={baseUrl}
        apiKey={key}
        errors={{ apiKey: keyError }}
        onBaseUrl={setBaseUrl}
        onApiKey={(next) => {
          setKey(next);
          setKeyError(undefined);
        }}
      />
      <div className="actions">
        <Button variant="primary" type="submit" disabled={working}>
          {working ? t("welcome.search.testing") : t("welcome.search.add")}
        </Button>
      </div>
      {working ? <Working>{t("welcome.search.adding", { provider: SEARCH_KIND_LABELS[kind] })}</Working> : null}
      {problem === undefined ? null : <Failure>{problem}</Failure>}
    </form>
  );
}
