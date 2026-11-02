// Shared validation report body: the project check screen and the events
// anomaly popup render the same list from one backend report.

import { Badge } from "@fluentui/react-components";
import { useTranslation } from "react-i18next";
import type { ValidationReport } from "../../api/types";
import { Button } from "../../components/ui/button";
import { formatBackupStamp } from "./backupStamp";
import "./projects.css";

const VISIBLE_ISSUES = 5;

export function ValidationSummary({
  report,
  locale,
  emptyLabel,
  onOpenEvent,
}: {
  report: ValidationReport;
  locale: string;
  emptyLabel: string;
  onOpenEvent?: (eventId: string) => void;
}) {
  const { t } = useTranslation(["project", "common"]);
  const clean = report.counts.error === 0 && report.counts.warning === 0;
  const hidden = report.issues.length - VISIBLE_ISSUES;

  return (
    <div className="projects-report">
      <p className="projects-report-head">
        {clean
          ? t("project:validationClean")
          : t("project:validationIssues", {
              errors: report.counts.error,
              warnings: report.counts.warning,
            })}
      </p>
      <p className="projects-hint projects-hint-tight">
        {t("project:checkedAt", {
          date: formatBackupStamp(report.checkedAt, locale, emptyLabel),
        })}
      </p>
      {report.issues.length > 0 ? (
        <ul className="projects-issues">
          {report.issues.slice(0, VISIBLE_ISSUES).map((issue, index) => {
            const issueText = t(`common:errors.${issue.code}`, {
              defaultValue: issue.code,
            });
            // "Event outside the lifespan" names the event first, so the row
            // can jump straight to it. Other issues stay read-only.
            const eventId = issue.entityIds[0];
            const canOpen =
              Boolean(onOpenEvent) &&
              issue.code === "EVENT_OUT_OF_LIFESPAN" &&
              Boolean(eventId);
            return (
              <li
                key={`${issue.code}-${issue.entityIds[0] ?? index}`}
                className="projects-issue"
              >
                <Badge
                  appearance="tint"
                  size="small"
                  color={issue.severity === "ERROR" ? "danger" : "warning"}
                >
                  {t(
                    issue.severity === "ERROR"
                      ? "project:severityError"
                      : "project:severityWarning",
                  )}
                </Badge>
                <span className="projects-issue-text">{issueText}</span>
                {canOpen ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${t("common:actions.open")}: ${issueText}`}
                    onClick={() => onOpenEvent?.(eventId)}
                  >
                    {t("common:actions.open")}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {hidden > 0 ? (
        <p className="projects-hint projects-hint-tight">
          {t("project:validationMore", { rest: hidden })}
        </p>
      ) : null}
    </div>
  );
}
