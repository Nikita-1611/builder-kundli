import { Routes, Route } from "react-router-dom";
import LandingScreen from "./screens/LandingScreen";
import SearchScreen from "./screens/SearchScreen";
import ReportScreen from "./screens/ReportScreen";
import CategoryScreen from "./screens/CategoryScreen";
import EmptyState from "./screens/EmptyState";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingScreen />} />
      <Route path="/search" element={<SearchScreen />} />
      <Route path="/builder/:id" element={<ReportScreen />} />
      <Route path="/builder/:id/:category" element={<CategoryScreen />} />
      <Route path="/not-found" element={<EmptyState />} />
      <Route path="*" element={<EmptyState />} />
    </Routes>
  );
}
