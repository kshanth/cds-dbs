'use strict'

/**
 * A class representing a Node in the join tree.
 *
 * @property {$refLink} - A reference link to this node.
 * @property {parent} - The parent Node of this node.
 * @property {where} - An optional condition to be applied to this node.
 * @property {children} - A Map of children nodes belonging to this node.
 */
class Node {
  constructor($refLink, parent, where = null) {
    this.$refLink = $refLink
    this.parent = parent
    this.where = where
    this.children = new Map()
  }
}

/**
 * A class representing the root of the join tree.
 *
 * @property {queryArtifact} - The artifact used to make the query.
 * @property {alias} - The alias of the artifact.
 * @property {parent} - The parent Node of this root, null for the root Node.
 * @property {children} - A Map of children nodes belonging to this root.
 */
class Root {
  constructor(querySource) {
    const [alias, queryArtifact] = querySource
    this.queryArtifact = queryArtifact
    this.alias = alias
    this.parent = null
    this.children = new Map()
  }
}

/**
 * A class representing a Join Tree.
 *
 * @property {_roots} - A Map of root nodes.
 * @property {isInitial} - A boolean indicating if the join tree is in its initial state.
 * @property {_queryAliases} - A Map of query aliases, which is used during the association to join translation.
 */
class JoinTree {
  constructor(sources) {
    this._roots = new Map()
    this.isInitial = true
    /**
     * A map that holds query aliases which are used during the
     * association to join translation. It is also considered during the
     * where exists expansion.
     *
     * The table aliases are treated case insensitive. The index of each
     * table alias entry, is the capitalized version of the alias.
     */
    this._queryAliases = new Map()
    Object.entries(sources).forEach(entry => {
      const alias = this.addNextAvailableTableAlias(entry[0])
      this._roots.set(alias, new Root(entry))
      if (entry[1].sources)
        // respect outer aliases
        this.addAliasesOfSubqueryInFrom(entry[1].sources)
    })
  }

  /**
   * Recursively adds aliases of subqueries from a given query source to the alias map.
   *
   * @param {object} sources - The sources of the inferred subquery in a FROM clause.
   */
  addAliasesOfSubqueryInFrom(sources) {
    Object.entries(sources).forEach(e => {
      this.addNextAvailableTableAlias(e[0])
      if (e[1].sources)
        // recurse
        this.addAliasesOfSubqueryInFrom(e[1].sources)
    })
  }

  /**
   * Calculates and adds the next available table alias to the alias map.
   *
   * @param {string} alias - The original alias name.
   * @returns {string} - The next unambiguous table alias.
   */
  addNextAvailableTableAlias(alias, outerQueries) {
    const upperAlias = alias.toUpperCase()
    if (this._queryAliases.get(upperAlias) || outerQueries?.some(outer => outerHasAlias(outer))) {
      let j = 2
      while (this._queryAliases.get(upperAlias + j) || outerQueries?.some(outer => outerHasAlias(outer, j))) j += 1
      alias += j
    }
    this._queryAliases.set(alias.toUpperCase(), alias)
    return alias

    function outerHasAlias(outer, number) {
      return outer.joinTree._queryAliases.get(number ? upperAlias + number : upperAlias)
    }
  }

  /**
   * Merges a column into the join tree.
   *
   * It begins by inferring the source of the given column, which is the table alias where the column is resolvable.
   * Each step during this process represents a node in the join tree. If a node already exists in the tree, the current step is replaced by the already merged node.
   * For each step, it checks whether it has been seen before. If so, it resets the $refLink to point to the already merged $refLink.
   * If not, it creates a new Node and ensures proper aliasing and foreign key access.
   *
   * @param {Object} col - The column object to be merged into the existing join tree. This object should have the properties $refLinks and ref.
   * @returns {boolean} - Always returns true, indicating the column has been successfully merged into the join tree.
   */
  mergeColumn(col) {
    if (this.isInitial) this.isInitial = false
    const head = col.$refLinks[0]
    let node = this._roots.get(head.alias)
    let i = 0
    if (!node) {
      this._roots.forEach(r => {
        // find the correct query source
        if (
          r.queryArtifact === head.target ||
          r.queryArtifact === head.target.target /** might as well be a query for order by */
        )
          node = r
      })
    } else {
      i += 1 // skip first step which is table alias
    }

    while (i < col.ref.length) {
      const step = col.ref[i]
      const { where } = step
      const id = where ? step.id + JSON.stringify(where) : step
      const next = node.children.get(id)
      const $refLink = col.$refLinks[i]
      if (next) {
        // step already seen before
        node = next
        col.$refLinks[i] = node.$refLink // re-set $refLink to point to already merged $refLink
      } else {
        if (col.expand && !col.ref[i + 1]) {
          node.$refLink.onlyForeignKeyAccess = false
          return true
        }
        const child = new Node($refLink, node, where)
        if (child.$refLink.definition.isAssociation) {
          if (child.where) {
            // always join relevant
            child.$refLink.onlyForeignKeyAccess = false
          } else {
            child.$refLink.onlyForeignKeyAccess = true
          }
          child.$refLink.alias = this.addNextAvailableTableAlias($refLink.alias)
        }

        const foreignKeys = node.$refLink?.definition.foreignKeys
        if (node.$refLink && (!foreignKeys || !(child.$refLink.alias in foreignKeys)))
          // foreign key access
          node.$refLink.onlyForeignKeyAccess = false

        node.children.set(id, child)
        node = child
      }
      i += 1
    }
    return true
  }

  /**
   * Performs a depth-first search for the next association in the children of the given node which does not only access foreign keys.
   *
   * @param {Node} node - The node from which to search for the next association.
   * @returns {Node|null} - Returns the node which represents an association or null if none was found.
   */
  findNextAssoc(node) {
    if (node.$refLink.definition.isAssociation && !node.$refLink.onlyForeignKeyAccess) return node
    // recurse on each child node
    for (const child of node.children.values()) {
      const grandChild = this.findNextAssoc(child)
      if (grandChild) return grandChild
    }

    return null
  }
}

module.exports = JoinTree
