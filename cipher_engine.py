import json
import math
import random

ALPHABET = "ABCDEFGHIJKLMNÑOPQRSTUVWXYZ"

CHAR_TO_NUM = {}
NUM_TO_CHAR = {}
for index in range(len(ALPHABET)):
    character = ALPHABET[index]
    number = index + 1
    CHAR_TO_NUM[character] = number
    NUM_TO_CHAR[number] = character


def determinant_integer(matrix):
    """Calcula el determinante entero por expansión de cofactores."""
    size = len(matrix)
    if size == 0:
        raise ValueError("La matriz clave debe ser cuadrada.")
    for row in matrix:
        if len(row) != size:
            raise ValueError("La matriz clave debe ser cuadrada.")

    if size == 1:
        return int(matrix[0][0])
    if size == 2:
        return int(matrix[0][0]) * int(matrix[1][1]) - int(matrix[0][1]) * int(matrix[1][0])

    determinant = 0
    for col in range(size):
        submatrix = []
        for row in range(1, size):
            submatrix_row = []
            for submatrix_col in range(size):
                if submatrix_col != col:
                    submatrix_row.append(int(matrix[row][submatrix_col]))
            submatrix.append(submatrix_row)

        sign = 1 if col % 2 == 0 else -1
        determinant += sign * int(matrix[0][col]) * determinant_integer(submatrix)
    return determinant


def multiply_matrices(left, right):
    """Multiplica matrices usando el producto punto de filas y columnas."""
    if not left or not right:
        raise ValueError("Las dimensiones no permiten multiplicar estas matrices.")

    inner_size = len(right)
    column_count = len(right[0])
    if column_count == 0:
        raise ValueError("Las dimensiones no permiten multiplicar estas matrices.")
    for row in left:
        if len(row) != inner_size:
            raise ValueError("Las dimensiones no permiten multiplicar estas matrices.")
    for row in right:
        if len(row) != column_count:
            raise ValueError("Las dimensiones no permiten multiplicar estas matrices.")

    result = []
    for row_index in range(len(left)):
        result_row = []
        for col_index in range(column_count):
            total = 0
            for inner_index in range(inner_size):
                total += left[row_index][inner_index] * right[inner_index][col_index]
            result_row.append(total)
        result.append(result_row)
    return result


def inverse_matrix_float(matrix):
    """Calcula la inversa con Gauss-Jordan usando operaciones de punto flotante."""
    size = len(matrix)
    if size == 0:
        raise ValueError("La matriz clave debe ser cuadrada.")
    for row in matrix:
        if len(row) != size:
            raise ValueError("La matriz clave debe ser cuadrada.")

    augmented = []
    for row_index in range(size):
        augmented_row = []
        for col_index in range(size):
            augmented_row.append(float(matrix[row_index][col_index]))
        for col_index in range(size):
            augmented_row.append(1.0 if row_index == col_index else 0.0)
        augmented.append(augmented_row)

    for col_index in range(size):
        pivot_row = col_index
        for row_index in range(col_index + 1, size):
            if abs(augmented[row_index][col_index]) > abs(augmented[pivot_row][col_index]):
                pivot_row = row_index

        pivot = augmented[pivot_row][col_index]
        if not math.isfinite(pivot) or pivot == 0.0:
            raise ValueError("No se pudo calcular la inversa de esta matriz.")

        augmented[col_index], augmented[pivot_row] = augmented[pivot_row], augmented[col_index]
        pivot = augmented[col_index][col_index]
        for entry_index in range(size * 2):
            augmented[col_index][entry_index] /= pivot

        for row_index in range(size):
            if row_index == col_index:
                continue
            factor = augmented[row_index][col_index]
            for entry_index in range(size * 2):
                augmented[row_index][entry_index] -= factor * augmented[col_index][entry_index]

    inverse = []
    for row_index in range(size):
        inverse_row = []
        for col_index in range(size, size * 2):
            inverse_row.append(augmented[row_index][col_index])
        inverse.append(inverse_row)
    return inverse


def random_invertible_matrix(dimension):
    """Genera una clave sumando múltiplos de filas de la identidad."""
    if dimension < 2:
        raise ValueError("La dimensión de la matriz debe ser al menos 2.")

    matrix = []
    for row_index in range(dimension):
        matrix_row = []
        for col_index in range(dimension):
            matrix_row.append(1 if row_index == col_index else 0)
        matrix.append(matrix_row)

    for _ in range(dimension * 3):
        target_row = random.randrange(dimension)
        source_row = random.randrange(dimension)
        while source_row == target_row:
            source_row = random.randrange(dimension)
        factor = random.choice([-2, -1, 1, 2])
        for col_index in range(dimension):
            matrix[target_row][col_index] += factor * matrix[source_row][col_index]
    return matrix


def py_determinant(matrix_json):
    matrix = json.loads(matrix_json)
    return str(determinant_integer(matrix))


def py_random_matrix(dimension):
    return json.dumps(random_invertible_matrix(int(dimension)))


def py_encrypt(key_json, text):
    key = json.loads(key_json)
    dimension = len(key)

    values = []
    for character in text:
        if character == " ":
            values.append(0)
        else:
            values.append(CHAR_TO_NUM[character.upper()])

    cell_count = dimension * dimension
    if len(values) > cell_count:
        raise ValueError("El mensaje supera la capacidad de la matriz.")

    padded = list(values)
    while len(padded) < cell_count:
        padded.append(0)

    plain_matrix = []
    for row_index in range(dimension):
        row_start = row_index * dimension
        row_end = row_start + dimension
        plain_matrix.append(padded[row_start:row_end])

    cipher_matrix = multiply_matrices(key, plain_matrix)
    for row in cipher_matrix:
        for value in row:
            if abs(value) > 2**53 - 1:
                raise ValueError("El resultado excede la precisión segura. Usa valores de clave más pequeños.")

    return json.dumps({
        "values": values,
        "padded": padded,
        "plainMatrix": plain_matrix,
        "cipherMatrix": cipher_matrix,
    })


def py_decrypt(key_json, cipher_json, original_length, lowercase_json):
    key = json.loads(key_json)
    cipher = json.loads(cipher_json)
    lowercase = json.loads(lowercase_json) if lowercase_json else None

    inverse = inverse_matrix_float(key)
    recovered_decimal = multiply_matrices(inverse, cipher)

    recovered = []
    for row in recovered_decimal:
        integer_row = []
        for value in row:
            if not math.isfinite(value):
                raise ValueError(
                    "La clave no coincide o la matriz cifrada está dañada: "
                    "se obtuvo un valor no entero fuera del rango 0–27."
                )
            integer = round(value)
            if abs(value - integer) > 1e-7 or integer < 0 or integer > 27:
                raise ValueError(
                    "La clave no coincide o la matriz cifrada está dañada: "
                    "se obtuvo un valor no entero fuera del rango 0–27."
                )
            integer_row.append(integer)
        recovered.append(integer_row)

    flattened = []
    for row in recovered:
        for value in row:
            flattened.append(value)

    if original_length is not None:
        values = flattened[:int(original_length)]
    else:
        values = list(flattened)
        while values and values[-1] == 0:
            values.pop()

    characters = []
    for index in range(len(values)):
        value = values[index]
        if value == 0:
            characters.append(" ")
        else:
            character = NUM_TO_CHAR[value]
            if lowercase and index < len(lowercase) and lowercase[index]:
                character = character.lower()
            characters.append(character)

    return json.dumps({
        "inverse": inverse,
        "recovered": recovered,
        "values": values,
        "text": "".join(characters),
    })
