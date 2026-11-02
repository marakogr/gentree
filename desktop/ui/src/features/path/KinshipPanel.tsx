// "How is this person related to the selected person?" block for the person
// card. Two directions:
// card person → reference person and reference person → card person, each with
// the structural term and a short readable chain.

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  Card,
  Link,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle2,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { useTranslation } from "react-i18next";
import { pathApi } from "../../api/client";
import type {
  Gender,
  KinshipDescriptor,
  PathResult,
  Person,
} from "../../api/types";
import { Combobox } from "../../components/ui/combobox";
import { EmptyState } from "../../components/ui/empty";
import { formatKinship } from "../../i18n/kinship";
import type { Locale } from "../../i18n";
import { normalizeError, type AppErrorEnvelope } from "../../lib/errors";
import { displayName, sortPersons } from "../persons/helpers";
import { chainName, pathChainLinks, stepWordKey } from "./labels";
import "./path.css";

export type KinshipPanelProps = {
  projectId: string;
  personId: string;
  /** Persons list to pick the reference person from; the home person by default. */
  persons: Person[];
  homePersonId?: string | null;
  onOpenPerson?: (personId: string) => void;
};

type Direction = { descriptor: KinshipDescriptor; path: PathResult };
type PanelData = { forward: Direction; backward: Direction };

const useStyles = makeStyles({
  muted: {
    color: tokens.colorNeutralForeground2,
  },
  term: {
    color: tokens.colorBrandForeground1,
  },
});

/** Home person first; otherwise the first other person in the list. */
function defaultReference(
  homePersonId: string | null,
  personId: string,
  persons: Person[],
): string {
  if (
    homePersonId !== null &&
    homePersonId !== personId &&
    persons.some((person) => person.id === homePersonId)
  ) {
    return homePersonId;
  }
  const other = persons.find((person) => person.id !== personId);
  return other?.id ?? "";
}

export function KinshipPanel({
  personId,
  persons,
  homePersonId = null,
  onOpenPerson,
}: KinshipPanelProps) {
  const { t, i18n } = useTranslation(["path", "person", "common"]);
  const locale = (i18n.language === "en" ? "en" : "ru") as Locale;
  const pickerId = useId();
  const styles = useStyles();

  const [referenceId, setReferenceId] = useState("");
  const [data, setData] = useState<PanelData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppErrorEnvelope | null>(null);

  const candidates = useMemo(
    () =>
      sortPersons(
        persons.filter((person) => person.id !== personId),
        "birth",
        "desc",
      ),
    [persons, personId],
  );

  const unknownName = t("person:unknownName");

  // The persons list may arrive after the first render; keep a valid choice.
  useEffect(() => {
    setReferenceId((current) => {
      if (
        current !== "" &&
        current !== personId &&
        persons.some((person) => person.id === current)
      ) {
        return current;
      }
      return defaultReference(homePersonId ?? null, personId, persons);
    });
  }, [persons, personId, homePersonId]);

  useEffect(() => {
    if (referenceId === "" || referenceId === personId) {
      setData(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all([
      pathApi.kinship(personId, referenceId),
      pathApi.find(personId, referenceId),
      pathApi.kinship(referenceId, personId),
      pathApi.find(referenceId, personId),
    ])
      .then(([forwardDescriptor, forwardPath, backwardDescriptor, backwardPath]) => {
        if (!active) return;
        setData({
          forward: { descriptor: forwardDescriptor, path: forwardPath },
          backward: { descriptor: backwardDescriptor, path: backwardPath },
        });
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setData(null);
        setError(normalizeError(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [personId, referenceId]);

  const personsById = useMemo(
    () => new Map(persons.map((person) => [person.id, person])),
    [persons],
  );

  const genderOf = useCallback(
    (id: string): Gender => personsById.get(id)?.gender ?? "UNKNOWN",
    [personsById],
  );

  const nameOf = useCallback(
    (id: string) => {
      const person = personsById.get(id);
      return person ? displayName(person, unknownName) : undefined;
    },
    [personsById, unknownName],
  );

  const items = useMemo(
    () =>
      candidates.map((person) => ({
        id: person.id,
        label: displayName(person, unknownName),
      })),
    [candidates, unknownName],
  );

  const fullName = (id: string): string => {
    const person = personsById.get(id);
    return person ? displayName(person, unknownName) : id;
  };

  const personName = fullName(personId);
  const referenceName = fullName(referenceId);

  const renderDirection = (
    direction: Direction | null,
    fromName: string,
    toName: string,
  ) => {
    if (direction === null) {
      return null;
    }
    if (!direction.path.found) {
      return (
        <Card className="kinship-direction">
          <div className="kinship-direction-head">
            <Text size={200} className={styles.muted}>
              {t("path:kinshipPanel.direction", { from: fromName, to: toName })}
            </Text>
          </div>
          <Text as="p" className={mergeClasses("kinship-empty", styles.muted)}>
            {t("path:notFound")}
          </Text>
        </Card>
      );
    }
    const term = formatKinship(direction.descriptor, locale, nameOf);
    const links = pathChainLinks(direction.path.path, genderOf);
    const originId = direction.path.path[0]?.personId;
    const originName =
      originId !== undefined
        ? chainName(personsById.get(originId), unknownName)
        : fromName;
    return (
      <Card className="kinship-direction">
        <div className="kinship-direction-head">
          <Text size={200} className={styles.muted}>
            {t("path:kinshipPanel.direction", { from: fromName, to: toName })}
          </Text>
        </div>
        <Text
          as="strong"
          size={600}
          weight="bold"
          className={mergeClasses("kinship-term", styles.term)}
        >
          {term}
        </Text>
        <p className="kinship-chain" aria-label={t("path:chainLabel")}>
          <Text as="span" weight="medium" className="path-chain-person">
            {originName}
          </Text>
          {links.map((link, index) => {
            const person = personsById.get(link.personId);
            const name = chainName(person, unknownName);
            return (
              <span
                className="path-chain-link"
                key={`${index}-${link.personId}`}
              >
                <Text
                  as="span"
                  className={mergeClasses("path-chain-arrow", styles.muted)}
                  aria-hidden="true"
                >
                  →
                </Text>
                <Text
                  as="span"
                  className={mergeClasses("path-chain-step", styles.muted)}
                >
                  {t(`path:${stepWordKey(link.direction, link.gender)}`)}
                </Text>
                {onOpenPerson ? (
                  <Link
                    as="button"
                    className="path-chain-person"
                    onClick={() => onOpenPerson(link.personId)}
                  >
                    {name}
                  </Link>
                ) : (
                  <Text as="span" weight="medium" className="path-chain-person">
                    {name}
                  </Text>
                )}
              </span>
            );
          })}
        </p>
      </Card>
    );
  };

  return (
    <section className="kinship-panel" aria-labelledby={`${pickerId}-title`}>
      <Subtitle2 as="h3" id={`${pickerId}-title`}>
        {t("path:kinshipPanel.title")}
      </Subtitle2>

      <div className="kinship-picker">
        <Combobox
          id={pickerId}
          items={items}
          value={referenceId}
          onChange={setReferenceId}
          placeholder={t("path:kinshipPanel.searchPlaceholder")}
          ariaLabel={t("path:kinshipPanel.searchPlaceholder")}
          emptyLabel={t("path:kinshipPanel.noMatch")}
          disabled={candidates.length === 0}
        />
      </div>

      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>
            {t(`errors.${error.code}`, {
              defaultValue: t("errors.UNKNOWN"),
            })}
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {candidates.length === 0 ? (
        <EmptyState compact text={t("path:kinshipPanel.empty")} />
      ) : loading ? (
        <Spinner size="tiny" label={t("common:loading")} />
      ) : data === null ? null : (
        <div className="kinship-directions">
          {renderDirection(data.forward, personName, referenceName)}
          {renderDirection(data.backward, referenceName, personName)}
        </div>
      )}
    </section>
  );
}

export default KinshipPanel;
