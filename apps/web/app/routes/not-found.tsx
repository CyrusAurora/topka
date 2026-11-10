// Any path no other route claims. Throwing the 404 from a matched route (instead of leaving the URL
// unmatched) lets the root loader run first, so the not-found page is drawn in the reader's language.
import { data } from "react-router";

export function loader() {
  throw data(null, { status: 404 });
}

export default function NotFound() {
  return null;
}
