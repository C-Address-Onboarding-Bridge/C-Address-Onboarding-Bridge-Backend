import type { MessageCatalog } from './types';

/** French (fr) translation catalog. */
export const fr: MessageCatalog = {
  'error.unknown':                     'Une erreur inconnue s\'est produite.',
  'error.request_failed':              'La requête a échoué avec le statut {{status}}.',

  'error.auth.unauthorized':           'Non autorisé. Vérifiez votre clé API.',
  'error.auth.forbidden':              'Interdit. Vous n\'avez pas la permission d\'effectuer cette action.',

  'error.validation.invalid_address':  'Adresse invalide : {{address}}.',
  'error.validation.invalid_amount':   'Montant invalide : {{amount}}. Doit être une chaîne d\'entier positif (stroops).',
  'error.validation.missing_field':    'Champ requis manquant : {{field}}.',
  'error.validation.generic':          'Erreur de validation : {{detail}}.',

  'error.not_found':                   'La ressource demandée est introuvable.',

  'error.rate_limit':                  'Trop de requêtes. Veuillez ralentir.',
  'error.rate_limit.retry_after':      'Trop de requêtes. Réessayez après {{seconds}} secondes.',

  'error.server':                      'Une erreur serveur s\'est produite. Veuillez réessayer plus tard.',

  'error.network':                     'Une erreur réseau s\'est produite. Vérifiez votre connexion et réessayez.',
  'error.timeout':                     'L\'opération "{{operation}}" a expiré après {{ms}} ms.',

  'error.offline.queued':              'Vous êtes hors ligne. La requête a été mise en file d\'attente et sera réessayée une fois la connexion rétablie.',
  'error.offline.not_queued':          'Vous êtes hors ligne. La requête n\'a pas pu être mise en file d\'attente.',
  'error.queue_full':                  'La file d\'attente hors ligne est pleine (maximum {{max}} entrées). La requête a été abandonnée.',

  'error.invalid_stellar_address':     '"{{address}}" n\'est pas une adresse Stellar valide.',
  'error.invalid_c_address':           '"{{address}}" n\'est pas une C-address valide (compte intelligent Soroban).',
  'error.invalid_g_address':           '"{{address}}" n\'est pas une G-address valide (compte Stellar classique).',

  'error.fee_too_high':                'Les frais de {{feeBps}} bps dépassent le maximum de {{maxBps}} bps.',
  'error.amount_too_small':            'Le montant {{amount}} est inférieur au minimum de {{min}} stroops.',
  'error.amount_too_large':            'Le montant {{amount}} dépasse le maximum de {{max}} stroops.',

  'error.unsupported_exchange':        'L\'échange "{{exchange}}" n\'est pas pris en charge.',
};
