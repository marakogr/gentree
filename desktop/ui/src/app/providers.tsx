import type { ReactNode } from "react";
import {
  FluentProvider,
  makeStyles,
  tokens,
  type Theme,
} from "@fluentui/react-components";

// Fluent renders its own root element; it has to fill the window and carry the
// theme surface colours so the legacy screens (still on CSS variables) sit on
// the same background. The page uses the slightly darker Fluent surface and
// leaves background1 for panels/cards.
const useStyles = makeStyles({
  root: {
    minHeight: "100vh",
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
  },
});

export function AppProviders({
  theme,
  children,
}: {
  theme: Theme;
  children: ReactNode;
}) {
  const styles = useStyles();
  return (
    // The provider class must stay free of layout/background: Fluent copies it
    // onto portal wrappers (menus, combobox listboxes), and a background there
    // would cover the whole app while a portal is open.
    <FluentProvider theme={theme} className="app-theme-root">
      <div className={styles.root}>{children}</div>
    </FluentProvider>
  );
}
