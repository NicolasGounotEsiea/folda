import { useStore } from "../store/useStore";

type AppStrings = {
  name: string; size: string; created: string; modified: string;
  tags: string; noTags: string; addTag: string;
  info: string; history: string;
  statistics: string; items: string;
  noActivity: string;
  loading: string;
  calculating: string;
  search: string;
  watching: string;
};

const translations: Record<string, AppStrings> = {
  en: {
    name: "Name", size: "Size", created: "Created", modified: "Modified",
    tags: "Tags", noTags: "No tags", addTag: "+ Add",
    info: "Info", history: "History",
    statistics: "Statistics", items: "Items",
    noActivity: "No activity recorded",
    loading: "Loading…",
    calculating: "Calculating…",
    search: "Search…",
    watching: "watching",
  },
  fr: {
    name: "Nom", size: "Taille", created: "Créé le", modified: "Modifié",
    tags: "Étiquettes", noTags: "Aucune étiquette", addTag: "+ Ajouter",
    info: "Infos", history: "Historique",
    statistics: "Statistiques", items: "Éléments",
    noActivity: "Aucune activité enregistrée",
    loading: "Chargement…",
    calculating: "Calcul…",
    search: "Rechercher…",
    watching: "surveillance",
  },
};

export function useTranslation(): AppStrings {
  const lang = useStore((s) => s.settings.language);
  return translations[lang] ?? translations.en;
}
