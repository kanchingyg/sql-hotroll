#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* Scoped Symbol-Table AST Rewriter + Inline _lc Lens Transformation Microbenchmark */
typedef struct {
    int64_t id;
    char full_name[64];
    char first_name[32];
    char last_name[32];
    int32_t stock_qty;
    int32_t _row_ver;
    char _lc[128];
} OrderRow;

static int is_cte_shadowed(const char *sql, const char *table_name) {
    const char *with_pos = strstr(sql, "WITH ");
    if (!with_pos) return 0;
    const char *tbl_pos = strstr(with_pos, table_name);
    const char *as_pos = strstr(with_pos, " AS");
    return (tbl_pos && as_pos && tbl_pos < as_pos) ? 1 : 0;
}

static void apply_forward_lens(OrderRow *row) {
    const char *space = strchr(row->full_name, ' ');
    if (space) {
        size_t fn_len = (size_t)(space - row->full_name);
        if (fn_len >= sizeof(row->first_name)) fn_len = sizeof(row->first_name) - 1;
        memcpy(row->first_name, row->full_name, fn_len);
        row->first_name[fn_len] = '\0';
        strncpy(row->last_name, space + 1, sizeof(row->last_name) - 1);
        row->last_name[sizeof(row->last_name) - 1] = '\0';
    } else {
        strncpy(row->first_name, row->full_name, sizeof(row->first_name) - 1);
        row->last_name[0] = '\0';
    }
    row->_row_ver += 1;
}

int main(void) {
    const char *q1 = "SELECT orders.id, orders.full_name FROM orders JOIN line_items ON orders.id = line_items.order_id;";
    const char *q2 = "WITH orders AS (SELECT id FROM archive_orders) SELECT * FROM orders;";
    OrderRow r = {101, "Ada Lovelace", "", "", 50, 1, "{\"tax_jurisdiction\":\"PY-ASU\"}"};
    uint64_t acc = 0;

    for (int i = 0; i < 50000; i++) {
        int shadow1 = is_cte_shadowed(q1, "orders");
        int shadow2 = is_cte_shadowed(q2, "orders");
        apply_forward_lens(&r);
        acc += (uint64_t)(shadow1 + shadow2 + r._row_ver + (int)r.first_name[0]);
    }
    printf("acc=%llu ver=%d fn=%s ln=%s\n", (unsigned long long)acc, r._row_ver, r.first_name, r.last_name);
    return 0;
}
