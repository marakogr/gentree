import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Caption1,
  Input,
  Text,
  Title2,
} from "@fluentui/react-components";
import {
  ArchiveRegular,
  ArrowLeftRegular,
  ArrowRightRegular,
  BranchForkRegular,
  CalendarLtrRegular,
  ChatRegular,
  ChevronRightRegular,
  FolderRegular,
  HatGraduationRegular,
  InfoRegular,
  OrganizationRegular,
  PeopleRegular,
  SearchRegular,
  type FluentIcon,
} from "@fluentui/react-icons";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty";
import {
  GLOBAL_NAV,
  HELP_NAV,
  PROJECT_NAV,
  SETTINGS_NAV,
  type NavItem,
  type ShellTab,
} from "../../lib/navigation";
import { filterHelpEntries, type HelpSearchEntry } from "./search";
import {
  HELP_PROJECT_SCREENS,
  HELP_SECTIONS,
  HELP_STEPS,
  HELP_TOPICS,
  type HelpTopic,
} from "./topics";
import "./help.css";

const NAV_ITEMS: readonly NavItem[] = [
  ...GLOBAL_NAV,
  ...PROJECT_NAV,
  HELP_NAV,
  SETTINGS_NAV,
];

/** One icon per article; unknown ids fall back to the book mark. */
const TOPIC_ICONS: Record<string, FluentIcon> = {
  start: FolderRegular,
  people: PeopleRegular,
  relations: BranchForkRegular,
  events: CalendarLtrRegular,
  tree: OrganizationRegular,
  find: SearchRegular,
  data: ArchiveRegular,
  assistant: ChatRegular,
};

function screenLabelKey(screen: ShellTab): string {
  return NAV_ITEMS.find((item) => item.id === screen)?.labelKey ?? "app.navHelp";
}

function topicIcon(topic: HelpTopic): FluentIcon {
  return TOPIC_ICONS[topic.id] ?? FolderRegular;
}

type CardProps = {
  topic: HelpTopic;
  onOpen: (id: string) => void;
};

function TopicCard({ topic, onOpen }: CardProps) {
  const { t } = useTranslation();
  const Icon = topicIcon(topic);
  return (
    <button
      type="button"
      className="help-card"
      onClick={() => onOpen(topic.id)}
    >
      <span className="help-card-icon" aria-hidden="true">
        <Icon fontSize={20} />
      </span>
      <span className="help-card-text">
        <span className="help-card-title">
          {t(`help:topics.${topic.id}.title`)}
        </span>
        <span className="help-card-summary">
          {t(`help:topics.${topic.id}.summary`)}
        </span>
      </span>
      <ChevronRightRegular
        className="help-card-arrow"
        fontSize={16}
        aria-hidden="true"
      />
    </button>
  );
}

type ArticleProps = {
  topic: HelpTopic;
  projectOpen: boolean;
  onBack: () => void;
  onNavigate: (screen: ShellTab) => void;
  onAskAssistant: (question: string) => void;
};

function HelpArticle({
  topic,
  projectOpen,
  onBack,
  onNavigate,
  onAskAssistant,
}: ArticleProps) {
  const { t } = useTranslation();
  const Icon = topicIcon(topic);
  const title = t(`help:topics.${topic.id}.title`);
  const summary = t(`help:topics.${topic.id}.summary`);
  const steps = HELP_STEPS.map((step) => t(`help:topics.${topic.id}.step${step}`));
  const screenBlocked = !projectOpen && HELP_PROJECT_SCREENS.has(topic.screen);
  const question = t("help:askTopic", { title });

  return (
    <article className="help-article" aria-labelledby={`help-${topic.id}-title`}>
      <button type="button" className="help-back" onClick={onBack}>
        <ArrowLeftRegular fontSize={16} aria-hidden="true" />
        {t("help:allTopics")}
      </button>

      <header className="help-article-head">
        <span className="help-article-icon" aria-hidden="true">
          <Icon fontSize={22} />
        </span>
        <div className="help-article-heading">
          <h2 className="help-article-title" id={`help-${topic.id}-title`}>
            {title}
          </h2>
          <Text as="p" className="help-summary">
            {summary}
          </Text>
        </div>
      </header>

      <div className="help-article-grid">
        <section className="help-steps-block" aria-labelledby="help-steps-title">
          <h3 className="help-steps-title" id="help-steps-title">
            {t("help:stepsLabel")}
          </h3>
          <ol className="help-steps">
            {steps.map((step, index) => (
              <li key={index}>
                <span className="help-step-number" aria-hidden="true">
                  {index + 1}
                </span>
                <Text as="span">{step}</Text>
              </li>
            ))}
          </ol>
        </section>

        <aside className="help-aside">
          <div className="help-note-card">
            <InfoRegular className="help-note-icon" fontSize={18} aria-hidden="true" />
            <div>
              <h3 className="help-note-title">{t("help:noteLabel")}</h3>
              <Caption1 as="p" className="help-note">
                {t(`help:topics.${topic.id}.note`)}
              </Caption1>
            </div>
          </div>
          <div className="help-actions">
            <Button
              variant="secondary"
              size="sm"
              disabled={screenBlocked}
              disabledReason={
                screenBlocked ? t("help:openProjectFirst") : undefined
              }
              onClick={() => onNavigate(topic.screen)}
            >
              {t("help:openScreen", {
                screen: t(`common:${screenLabelKey(topic.screen)}`),
              })}
              <ArrowRightRegular aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAskAssistant(question)}>
              {t("help:askAssistant")}
            </Button>
          </div>
        </aside>
      </div>
    </article>
  );
}

type Props = {
  /** Project screens stay listed without a project but cannot be opened. */
  projectOpen: boolean;
  onNavigate: (screen: ShellTab) => void;
  onAskAssistant: (question: string) => void;
  onStartTour?: () => void;
};

export default function HelpPage({
  projectOpen,
  onNavigate,
  onAskAssistant,
  onStartTour,
}: Props) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const entries: HelpSearchEntry[] = HELP_TOPICS.map((topic) => ({
    id: topic.id,
    text: [
      t(`help:topics.${topic.id}.title`),
      t(`help:topics.${topic.id}.summary`),
      ...HELP_STEPS.map((step) => t(`help:topics.${topic.id}.step${step}`)),
      t(`help:topics.${topic.id}.note`),
    ].join(" "),
  }));

  const searching = query.trim() !== "";
  const matches = searching ? filterHelpEntries(entries, query) : [];
  const matchingTopics = HELP_TOPICS.filter((topic) => matches.includes(topic.id));
  const selectedTopic = HELP_TOPICS.find((topic) => topic.id === selected) ?? null;

  const openTopic = (id: string) => {
    setSelected(id);
    setQuery("");
  };

  const askAboutQuery = () => {
    onAskAssistant(t("help:askFree", { question: query.trim() }));
  };

  return (
    <section className="panel help-page" aria-labelledby="help-title">
      <header className="help-head">
        <Title2 as="h1" id="help-title">
          {t("help:title")}
        </Title2>
        <div className="help-head-actions">
          <Input
            className="help-search"
            type="search"
            value={query}
            placeholder={t("help:searchPlaceholder")}
            aria-label={t("help:searchLabel")}
            contentBefore={<SearchRegular aria-hidden="true" />}
            onChange={(_, data) => setQuery(data.value)}
          />
          {onStartTour ? (
            <Button variant="secondary" onClick={onStartTour}>
              <HatGraduationRegular fontSize={16} aria-hidden="true" />
              {t("help:startTour")}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="help-body">
        {searching ? (
          matchingTopics.length === 0 ? (
            <div className="help-empty">
              <EmptyState compact text={t("help:noResults")} />
              <Button variant="primary" size="sm" onClick={askAboutQuery}>
                {t("help:askAssistant")}
              </Button>
              <Caption1 as="p" className="help-note">
                {t("help:askAssistantHint")}
              </Caption1>
            </div>
          ) : (
            <section
              className="help-group"
              aria-label={t("help:searchResultsLabel")}
            >
              <div className="help-results">
                <h2 className="help-results-count">
                  {t("help:resultsCount", { total: matchingTopics.length })}
                </h2>
                <Button variant="ghost" size="sm" onClick={askAboutQuery}>
                  {t("help:askAssistant")}
                </Button>
              </div>
              <div className="help-cards">
                {matchingTopics.map((topic) => (
                  <TopicCard key={topic.id} topic={topic} onOpen={openTopic} />
                ))}
              </div>
            </section>
          )
        ) : selectedTopic ? (
          <HelpArticle
            topic={selectedTopic}
            projectOpen={projectOpen}
            onBack={() => setSelected(null)}
            onNavigate={onNavigate}
            onAskAssistant={onAskAssistant}
          />
        ) : (
          <div className="help-index">
            {HELP_SECTIONS.map((section) => {
              const topics = HELP_TOPICS.filter(
                (topic) => topic.section === section,
              );
              if (topics.length === 0) return null;
              return (
                <section
                  className="help-group"
                  key={section}
                  aria-labelledby={`help-section-${section}`}
                >
                  <h2
                    className="help-group-title"
                    id={`help-section-${section}`}
                  >
                    {t(`help:sections.${section}`)}
                  </h2>
                  <div className="help-cards">
                    {topics.map((topic) => (
                      <TopicCard
                        key={topic.id}
                        topic={topic}
                        onOpen={openTopic}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
