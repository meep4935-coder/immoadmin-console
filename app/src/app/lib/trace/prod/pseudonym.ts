/**
 * Pseudonymisation : identifiant de compte → référence stable, non réversible sans le secret.
 *
 * HMAC-SHA256 avec TRACE_PSEUDONYM_SECRET (clé SERVEUR, jamais envoyée au navigateur).
 *  • même compte + même secret → même référence (on peut suivre un utilisateur dans le temps et l'effacer sur demande) ;
 *  • sans le secret, impossible de retrouver le compte à partir de la référence ;
 *  • changer le secret coupe le lien avec les anciennes données ; détruire le secret les rend inattribuables.
 */
import { createHmac } from "node:crypto";

export function userRef(secret: string, userId: string): string {
  return "u_" + createHmac("sha256", secret).update(`uid:${userId}`).digest("hex").slice(0, 16);
}
